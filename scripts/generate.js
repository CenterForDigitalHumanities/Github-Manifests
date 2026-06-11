import fs from "node:fs/promises"
import path from "node:path"
import { extname } from "node:path"
import sizeOf from "image-size"
import mime from "mime-types"
import {
  DEFAULT_PRESENTATION_VERSION,
  FETCH_TIMEOUT_MS,
  IIIF_CONTEXTS,
  MAX_FILE_SIZE_WARNING_BYTES,
  MAX_IMAGE_DIMENSION_WARNING,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_IMAGE_MIME_TYPES,
  SUPPORTED_PRESENTATION_VERSIONS,
  TOP_LEVEL_ALLOWED_INFO_KEYS
} from "./config.js"
import {
  buildSiteBaseUrl,
  ensureDir,
  languageMapFrom,
  metadataFromInfo,
  naturalCompare,
  parseArgs,
  readYamlFile,
  repoRoot,
  toPosixPath,
  writeJson,
  writeText
} from "./utils.js"

const ROOT_PROJECT_INDEX_START = "<!-- GENERATED_PROJECT_LINKS_START -->"
const ROOT_PROJECT_INDEX_END = "<!-- GENERATED_PROJECT_LINKS_END -->"

function createWarning(code, message, details = {}) {
  return {
    code,
    message,
    details
  }
}

async function listProjectDirectories(projectsRoot) {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(naturalCompare)
}

function isSupportedImageFile(fileName) {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extname(fileName).toLowerCase())
}

function isLinkFile(fileName) {
  return extname(fileName).toLowerCase() === ".lnk"
}

function normalizeUrl(url) {
  if (typeof url !== "string") {
    return undefined
  }
  const value = url.trim()
  if (!value) {
    return undefined
  }
  if (!/^https?:\/\//i.test(value)) {
    return undefined
  }
  return value
}

function toResourceTypeFromMime(mimeType) {
  if (!mimeType || typeof mimeType !== "string") {
    return "Image"
  }

  if (mimeType.startsWith("image/")) {
    return "Image"
  }
  if (mimeType.startsWith("video/")) {
    return "Video"
  }
  if (mimeType.startsWith("audio/")) {
    return "Sound"
  }
  if (mimeType.startsWith("text/")) {
    return "Text"
  }

  return "Dataset"
}

async function getLocalFileDimensions(filePath) {
  const buffer = await fs.readFile(filePath)
  const dimensions = sizeOf(buffer)
  return {
    width: dimensions.width,
    height: dimensions.height
  }
}

async function probeRemoteResource(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    })

    const contentTypeRaw = response.headers.get("content-type") ?? ""
    const contentType = contentTypeRaw.split(";")[0].trim().toLowerCase()
    const contentLengthRaw = response.headers.get("content-length")
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined

    // We only need headers/status for warnings and type hints.
    await response.body?.cancel()

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      contentLength
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message
    }
  } finally {
    clearTimeout(timeout)
  }
}

function buildImageUrl(siteBaseUrl, projectName, imageRelativePath) {
  return `${siteBaseUrl}/projects/${projectName}/${toPosixPath(imageRelativePath)}`
}

function buildProjectDirectoryUrl(projectName) {
  return `./projects/${projectName}/`
}

function resolvePresentationVersion(info, warnings) {
  const raw = info.presentationVersion
  if (raw === undefined || raw === null) {
    return DEFAULT_PRESENTATION_VERSION
  }

  const version = Number(raw)
  if (!SUPPORTED_PRESENTATION_VERSIONS.includes(version)) {
    warnings.push(
      createWarning(
        "unsupported-presentation-version",
        `info.yml presentationVersion '${raw}' is not supported. Using default version ${DEFAULT_PRESENTATION_VERSION}. Supported versions: ${SUPPORTED_PRESENTATION_VERSIONS.join(", ")}.`,
        { value: raw }
      )
    )
    return DEFAULT_PRESENTATION_VERSION
  }

  return version
}

function normalizeTopLevelFields(info, warnings) {
  const out = {}

  const summary = languageMapFrom(info.summary)
  if (summary) {
    out.summary = summary
  }

  if (typeof info.rights === "string" && info.rights.trim()) {
    out.rights = info.rights.trim()
  }

  if (info.requiredStatement?.label && info.requiredStatement?.value) {
    const label = languageMapFrom(info.requiredStatement.label)
    const value = languageMapFrom(info.requiredStatement.value)
    if (label && value) {
      out.requiredStatement = { label, value }
    }
  }

  const passthrough = [
    "provider",
    "homepage",
    "rendering",
    "service",
    "services",
    "seeAlso",
    "behavior",
    "viewingDirection",
    "navDate",
    "start",
    "thumbnail"
  ]

  for (const key of passthrough) {
    if (info[key] !== undefined) {
      out[key] = info[key]
    }
  }

  for (const key of Object.keys(info)) {
    if (!TOP_LEVEL_ALLOWED_INFO_KEYS.has(key)) {
      warnings.push(
        createWarning(
          "unknown-info-key",
          `Ignoring unknown top-level info.yml key '${key}'. Add custom values through metadata entries instead.`,
          { key }
        )
      )
    }
  }

  return out
}

function toManifestMetadata(info) {
  return metadataFromInfo(info.metadata)
}

function makeCanvas(canvasBaseId, index, label, body) {
  const canvasId = `${canvasBaseId}/canvas/${index}`
  const pageId = `${canvasBaseId}/page/${index}/1`
  const annotationId = `${canvasBaseId}/annotation/${index}/1`

  const canvas = {
    id: canvasId,
    type: "Canvas",
    label: languageMapFrom(label ?? `Page ${index}`),
    items: [
      {
        id: pageId,
        type: "AnnotationPage",
        items: [
          {
            id: annotationId,
            type: "Annotation",
            motivation: "painting",
            body,
            target: canvasId
          }
        ]
      }
    ]
  }

  if (body.width && body.height) {
    canvas.width = body.width
    canvas.height = body.height
  }

  return canvas
}

async function collectImageFolderResources(projectDir, projectName, siteBaseUrl, warnings) {
  const imagesDir = path.join(projectDir, "images")
  const entries = await fs.readdir(imagesDir, { withFileTypes: true }).catch(() => [])

  const resources = []

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const fileName = entry.name
    const fullPath = path.join(imagesDir, fileName)

    if (isSupportedImageFile(fileName)) {
      const stat = await fs.stat(fullPath)
      const relativePath = path.relative(projectDir, fullPath)
      const imageUrl = buildImageUrl(siteBaseUrl, projectName, relativePath)

      const mimeType = (mime.lookup(fileName) || "application/octet-stream").toLowerCase()
      const dimensions = await getLocalFileDimensions(fullPath).catch(() => ({}))

      if (dimensions.width > MAX_IMAGE_DIMENSION_WARNING || dimensions.height > MAX_IMAGE_DIMENSION_WARNING) {
        warnings.push(
          createWarning("large-dimensions", `Image '${fileName}' exceeds ${MAX_IMAGE_DIMENSION_WARNING}px in width or height.`, {
            file: fileName,
            width: dimensions.width,
            height: dimensions.height
          })
        )
      }

      if (stat.size > MAX_FILE_SIZE_WARNING_BYTES) {
        warnings.push(
          createWarning("large-file", `Image '${fileName}' is larger than 15 MB.`, {
            file: fileName,
            sizeBytes: stat.size
          })
        )
      }

      if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
        warnings.push(
          createWarning("unsupported-media", `Image '${fileName}' has unsupported media type '${mimeType}'.`, {
            file: fileName,
            mimeType
          })
        )
      }

      resources.push({
        key: `local:${fileName}`,
        source: "local-image",
        fileName,
        label: fileName,
        order: undefined,
        body: {
          id: imageUrl,
          type: "Image",
          format: mimeType,
          width: dimensions.width,
          height: dimensions.height
        }
      })
      continue
    }

    if (isLinkFile(fileName)) {
      const raw = await fs.readFile(fullPath, "utf8")
      const url = normalizeUrl(raw)
      if (!url) {
        warnings.push(
          createWarning("invalid-link-file", `Link file '${fileName}' does not contain a valid HTTP(S) URL.`, {
            file: fileName
          })
        )
        continue
      }

      const probe = await probeRemoteResource(url)
      if (!probe.ok) {
        warnings.push(
          createWarning("unreachable-remote", `External URL from '${fileName}' did not return a successful response.`, {
            file: fileName,
            url,
            status: probe.status,
            error: probe.error
          })
        )
      }

      if (probe.contentLength && probe.contentLength > MAX_FILE_SIZE_WARNING_BYTES) {
        warnings.push(
          createWarning("large-remote-file", `External URL from '${fileName}' reports content larger than 15 MB.`, {
            file: fileName,
            url,
            sizeBytes: probe.contentLength
          })
        )
      }

      const mimeType = probe.contentType || (mime.lookup(url) || "application/octet-stream").toLowerCase()
      if (!mimeType.startsWith("image/")) {
        warnings.push(
          createWarning("unsupported-media", `External URL from '${fileName}' resolves to unsupported media type '${mimeType}'.`, {
            file: fileName,
            url,
            mimeType
          })
        )
      }

      resources.push({
        key: `file:${fileName}`,
        source: "link-file",
        fileName,
        label: path.basename(fileName, ".lnk"),
        order: undefined,
        body: {
          id: url,
          type: toResourceTypeFromMime(mimeType),
          format: mimeType
        }
      })
    }
  }

  return resources.sort((a, b) => naturalCompare(a.fileName, b.fileName))
}

async function collectInfoResources(infoResources, warnings) {
  if (!Array.isArray(infoResources)) {
    return []
  }

  const resources = []

  for (const [index, entry] of infoResources.entries()) {
    if (!entry || typeof entry !== "object") {
      warnings.push(
        createWarning("invalid-resource-entry", "Skipping invalid resource entry in info.yml resources.", {
          index
        })
      )
      continue
    }

    const src = normalizeUrl(entry.url)
    const fileName = typeof entry.file === "string" ? entry.file : undefined
    if (!src && !fileName) {
      warnings.push(
        createWarning("invalid-resource-entry", "Resource entries require either 'url' or 'file'.", {
          index
        })
      )
      continue
    }

    resources.push({
      key: src ? `url:${src}` : `file:${fileName}`,
      source: src ? "info-url" : "info-file",
      fileName: fileName ?? src,
      label: entry.label ?? fileName ?? src,
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : undefined,
      infoEntry: entry,
      url: src,
      file: fileName
    })
  }

  return resources
}

async function resolveInfoResources(projectDir, projectName, siteBaseUrl, infoResources, warnings) {
  const resolved = []
  for (const resource of infoResources) {
    if (resource.url) {
      const probe = await probeRemoteResource(resource.url)
      const mimeType =
        (resource.infoEntry.format || probe.contentType || mime.lookup(resource.url) || "application/octet-stream").toLowerCase()

      if (!probe.ok) {
        warnings.push(
          createWarning("unreachable-remote", `External URL '${resource.url}' did not return a successful response.`, {
            url: resource.url,
            status: probe.status,
            error: probe.error
          })
        )
      }

      if (probe.contentLength && probe.contentLength > MAX_FILE_SIZE_WARNING_BYTES) {
        warnings.push(
          createWarning("large-remote-file", `External URL '${resource.url}' reports content larger than 15 MB.`, {
            url: resource.url,
            sizeBytes: probe.contentLength
          })
        )
      }

      if (!mimeType.startsWith("image/")) {
        warnings.push(
          createWarning("unsupported-media", `External URL '${resource.url}' resolves to unsupported media type '${mimeType}'.`, {
            url: resource.url,
            mimeType
          })
        )
      }

      resolved.push({
        key: resource.key,
        source: resource.source,
        fileName: resource.fileName,
        label: resource.label,
        order: resource.order,
        body: {
          id: resource.url,
          type: toResourceTypeFromMime(mimeType),
          format: mimeType,
          width: resource.infoEntry.width,
          height: resource.infoEntry.height,
          service: resource.infoEntry.service
        }
      })
      continue
    }

    const localPath = path.join(projectDir, "images", resource.file)
    const stat = await fs.stat(localPath).catch(() => undefined)
    if (!stat || !stat.isFile()) {
      warnings.push(
        createWarning("missing-local-file", `info.yml resource references missing local file '${resource.file}'.`, {
          file: resource.file
        })
      )
      continue
    }

    if (extname(resource.file).toLowerCase() === ".lnk") {
      const raw = await fs.readFile(localPath, "utf8")
      const linkedUrl = normalizeUrl(raw)
      if (!linkedUrl) {
        warnings.push(
          createWarning("invalid-link-file", `Link file '${resource.file}' does not contain a valid HTTP(S) URL.`, {
            file: resource.file
          })
        )
        continue
      }

      const probe = await probeRemoteResource(linkedUrl)
      const mimeType =
        (resource.infoEntry.format || probe.contentType || mime.lookup(linkedUrl) || "application/octet-stream").toLowerCase()

      if (!probe.ok) {
        warnings.push(
          createWarning("unreachable-remote", `External URL from '${resource.file}' did not return a successful response.`, {
            file: resource.file,
            url: linkedUrl,
            status: probe.status,
            error: probe.error
          })
        )
      }

      if (probe.contentLength && probe.contentLength > MAX_FILE_SIZE_WARNING_BYTES) {
        warnings.push(
          createWarning("large-remote-file", `External URL from '${resource.file}' reports content larger than 15 MB.`, {
            file: resource.file,
            url: linkedUrl,
            sizeBytes: probe.contentLength
          })
        )
      }

      if (!mimeType.startsWith("image/")) {
        warnings.push(
          createWarning("unsupported-media", `External URL from '${resource.file}' resolves to unsupported media type '${mimeType}'.`, {
            file: resource.file,
            url: linkedUrl,
            mimeType
          })
        )
      }

      resolved.push({
        key: resource.key,
        source: resource.source,
        fileName: resource.fileName,
        label: resource.label,
        order: resource.order,
        body: {
          id: linkedUrl,
          type: toResourceTypeFromMime(mimeType),
          format: mimeType,
          width: resource.infoEntry.width,
          height: resource.infoEntry.height,
          service: resource.infoEntry.service
        }
      })
      continue
    }

    const fileExt = extname(resource.file).toLowerCase()
    const mimeType =
      (resource.infoEntry.format || mime.lookup(resource.file) || "application/octet-stream").toLowerCase()
    const imageUrl = buildImageUrl(siteBaseUrl, projectName, path.join("images", resource.file))
    const dimensions = await getLocalFileDimensions(localPath).catch(() => ({}))

    if (dimensions.width > MAX_IMAGE_DIMENSION_WARNING || dimensions.height > MAX_IMAGE_DIMENSION_WARNING) {
      warnings.push(
        createWarning("large-dimensions", `Image '${resource.file}' exceeds ${MAX_IMAGE_DIMENSION_WARNING}px in width or height.`, {
          file: resource.file,
          width: dimensions.width,
          height: dimensions.height
        })
      )
    }

    if (stat.size > MAX_FILE_SIZE_WARNING_BYTES) {
      warnings.push(
        createWarning("large-file", `Image '${resource.file}' is larger than 15 MB.`, {
          file: resource.file,
          sizeBytes: stat.size
        })
      )
    }

    if (!SUPPORTED_IMAGE_EXTENSIONS.has(fileExt) || !mimeType.startsWith("image/")) {
      warnings.push(
        createWarning("unsupported-media", `Resource '${resource.file}' has unsupported media type '${mimeType}'.`, {
          file: resource.file,
          mimeType
        })
      )
    }

    resolved.push({
      key: resource.key,
      source: resource.source,
      fileName: resource.fileName,
      label: resource.label,
      order: resource.order,
      body: {
        id: imageUrl,
        type: "Image",
        format: mimeType,
        width: resource.infoEntry.width ?? dimensions.width,
        height: resource.infoEntry.height ?? dimensions.height,
        service: resource.infoEntry.service
      }
    })
  }

  return resolved
}

function mergeAndOrderResources(infoResolved, folderResources) {
  const ordered = []
  const seenKeys = new Set()
  const seenBodyIds = new Set()

  const infoOrdered = [...infoResolved].sort((a, b) => {
    const aOrder = a.order ?? Number.MAX_SAFE_INTEGER
    const bOrder = b.order ?? Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) {
      return aOrder - bOrder
    }
    return naturalCompare(String(a.fileName), String(b.fileName))
  })

  for (const item of infoOrdered) {
    seenKeys.add(item.key)
    if (item.body?.id) {
      seenBodyIds.add(item.body.id)
    }
    ordered.push(item)
  }

  for (const item of folderResources) {
    if (seenKeys.has(item.key)) {
      continue
    }
    if (item.body?.id && seenBodyIds.has(item.body.id)) {
      continue
    }
    ordered.push(item)
  }

  return ordered
}

function buildCanvases(canvasBaseId, resources) {
  return resources.map((resource, index) => {
    const body = {
      id: resource.body.id,
      type: resource.body.type ?? "Image"
    }

    if (resource.body.format) {
      body.format = resource.body.format
    }
    if (resource.body.width) {
      body.width = resource.body.width
    }
    if (resource.body.height) {
      body.height = resource.body.height
    }
    if (resource.body.service) {
      body.service = Array.isArray(resource.body.service) ? resource.body.service : [resource.body.service]
    }

    return makeCanvas(canvasBaseId, index + 1, resource.label, body)
  })
}

function buildManifestContent({ projectName, info, resources, canvasBaseId, warnings }) {
  const topLevel = normalizeTopLevelFields(info, warnings)
  const manifestLabel = languageMapFrom(info.label ?? projectName)
  const metadata = toManifestMetadata(info)
  const canvases = buildCanvases(canvasBaseId, resources)

  if (!topLevel.rights) {
    warnings.push(
      createWarning(
        "missing-rights",
        "Manifest has no rights statement. Add rights in info.yml when possible.",
        {}
      )
    )
  }

  return { topLevel, manifestLabel, metadata, canvases }
}

function serializeManifest({ manifestId, presentationVersion, content }) {
  const manifest = {
    "@context": IIIF_CONTEXTS[presentationVersion],
    id: manifestId,
    type: "Manifest",
    label: content.manifestLabel,
    metadata: content.metadata,
    items: content.canvases
  }

  Object.assign(manifest, content.topLevel)

  return manifest
}

function generateProjectReadme(projectName, { manifestUrl, manifestV3Url, manifestV4Url, presentationVersion }) {
  const encodedManifestUrl = encodeURIComponent(manifestUrl)
  const miradorUrl = `https://projectmirador.org/embed/?iiif-content=${encodedManifestUrl}`
  const universalViewerUrl = `https://uv-v3.netlify.app/#?manifest=${encodedManifestUrl}`
  const tpenImportUrl = `https://app.t-pen.org/project/import?manifest=${encodedManifestUrl}`

  return `# ${projectName}\n\nThis project is generated by repository scripts.\n\n## Inputs\n- Add local images in images/\n- Add external references using .lnk files in images/ (one HTTP(S) URL per file)\n- Optional advanced configuration in info.yml\n\n## Generated Outputs\n- manifest.json (IIIF Presentation ${presentationVersion})\n- manifest-v3.json (IIIF Presentation 3)\n- manifest-v4.json (IIIF Presentation 4)\n- WARNING.md\n\n## IIIF Presentation Versions\nmanifest.json is the primary manifest and currently uses IIIF Presentation ${presentationVersion}.\nSet presentationVersion in info.yml to switch the primary version.\nVersion-pinned manifests are always available for tools that require a specific version.\n\n## Links\n- [Manifest.json](${manifestUrl})\n- [Presentation 3 manifest](${manifestV3Url})\n- [Presentation 4 manifest](${manifestV4Url})\n- [Images folder](./images/)\n- [Mirador Viewer](${miradorUrl})\n- [Universal Viewer](${universalViewerUrl})\n- [TPEN3 Create Project](${tpenImportUrl})\n\n## TPEN3\nUse the TPEN3 import link above to create a new project directly from this manifest.\n\n> This file is regenerated when manifest generation runs. Put durable custom metadata in info.yml.\n`
}

function generateRootProjectIndex(projectNames) {
  const items = projectNames
    .map((projectName) => `- [${projectName}](${buildProjectDirectoryUrl(projectName)})`)
    .join("\n")

  return `${ROOT_PROJECT_INDEX_START}\n## Projects\n\n${items}\n${ROOT_PROJECT_INDEX_END}`
}

async function updateRootReadme(projectNames) {
  const readmePath = path.join(repoRoot, "README.md")
  const readme = await fs.readFile(readmePath, "utf8")
  const generatedSection = generateRootProjectIndex(projectNames)
  const existingSectionPattern = new RegExp(
    `${ROOT_PROJECT_INDEX_START}[\\s\\S]*?${ROOT_PROJECT_INDEX_END}`,
    "m"
  )

  if (existingSectionPattern.test(readme)) {
    const updatedReadme = readme.replace(existingSectionPattern, generatedSection)
    await writeText(readmePath, updatedReadme)
    return
  }

  const insertionMarker = "## Project Inputs"
  const insertionIndex = readme.indexOf(insertionMarker)
  if (insertionIndex === -1) {
    throw new Error("Could not find '## Project Inputs' section in README.md to insert project links.")
  }

  const updatedReadme = `${readme.slice(0, insertionIndex)}${generatedSection}\n\n${readme.slice(insertionIndex)}`
  await writeText(readmePath, updatedReadme)
}

function generateWarningsMarkdown(projectName, warnings) {
  const header = `# Warnings for ${projectName}\n\nThis file is generated.\n\n`

  if (warnings.length === 0) {
    return `${header}No warnings were generated.\n`
  }

  const items = warnings
    .map((warning, index) => {
      const details = Object.keys(warning.details || {}).length
        ? `\n  Details: ${JSON.stringify(warning.details)}`
        : ""
      return `${index + 1}. [${warning.code}] ${warning.message}${details}`
    })
    .join("\n")

  return `${header}${items}\n`
}

async function generateProject(projectName) {
  const projectDir = path.join(repoRoot, "projects", projectName)
  const infoPath = path.join(projectDir, "info.yml")
  const manifestPath = path.join(projectDir, "manifest.json")
  const warningPath = path.join(projectDir, "WARNING.md")
  const readmePath = path.join(projectDir, "README.md")

  const warnings = []
  const info = await readYamlFile(infoPath)
  const siteBaseUrl = buildSiteBaseUrl()

  const folderResources = await collectImageFolderResources(projectDir, projectName, siteBaseUrl, warnings)
  const infoResources = await collectInfoResources(info.resources, warnings)
  const infoResolved = await resolveInfoResources(projectDir, projectName, siteBaseUrl, infoResources, warnings)

  const orderedResources = mergeAndOrderResources(infoResolved, folderResources)

  if (orderedResources.length === 0) {
    warnings.push(
      createWarning(
        "no-resources",
        "No resources found. Add local images or .lnk files in images/, or add resources in info.yml.",
        {}
      )
    )
  }

  const presentationVersion = resolvePresentationVersion(info, warnings)
  const projectBaseUrl = `${siteBaseUrl}/projects/${projectName}`
  const manifestUrl = `${projectBaseUrl}/manifest.json`

  // Canvas, page, and annotation ids are derived from the primary manifest url
  // in every serialization so annotations stay valid across versions.
  const content = buildManifestContent({
    projectName,
    info,
    resources: orderedResources,
    canvasBaseId: manifestUrl,
    warnings
  })

  await ensureDir(projectDir)
  await writeJson(
    manifestPath,
    serializeManifest({ manifestId: manifestUrl, presentationVersion, content })
  )

  const versionedUrls = {}
  for (const version of SUPPORTED_PRESENTATION_VERSIONS) {
    const versionedFileName = `manifest-v${version}.json`
    const versionedUrl = `${projectBaseUrl}/${versionedFileName}`
    versionedUrls[version] = versionedUrl
    await writeJson(
      path.join(projectDir, versionedFileName),
      serializeManifest({ manifestId: versionedUrl, presentationVersion: version, content })
    )
  }

  await writeText(
    readmePath,
    generateProjectReadme(projectName, {
      manifestUrl,
      manifestV3Url: versionedUrls[3],
      manifestV4Url: versionedUrls[4],
      presentationVersion
    })
  )
  await writeText(warningPath, generateWarningsMarkdown(projectName, warnings))

  return {
    projectName,
    warningCount: warnings.length
  }
}

async function main() {
  const { all, projectArg } = parseArgs(process.argv)
  const projectsRoot = path.join(repoRoot, "projects")
  await ensureDir(projectsRoot)

  let projects = []
  if (all) {
    projects = await listProjectDirectories(projectsRoot)
  } else if (projectArg) {
    projects = [projectArg]
  } else {
    projects = await listProjectDirectories(projectsRoot)
  }

  if (projects.length === 0) {
    console.log("No projects found in projects/. Nothing to generate.")
    return
  }

  const results = []
  for (const projectName of projects) {
    const result = await generateProject(projectName)
    results.push(result)
  }

  const allProjectNames = await listProjectDirectories(projectsRoot)
  await updateRootReadme(allProjectNames)

  for (const result of results) {
    console.log(`Generated ${result.projectName} (warnings: ${result.warningCount})`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
