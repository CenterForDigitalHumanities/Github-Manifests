import fs from "node:fs/promises"
import path from "node:path"
import { IIIF_CONTEXTS, SUPPORTED_PRESENTATION_VERSIONS } from "./config.js"
import { parseArgs, repoRoot } from "./utils.js"

const SUPPORTED_CONTEXTS = new Set(Object.values(IIIF_CONTEXTS))

function fail(message) {
  throw new Error(message)
}

async function listProjectDirectories(projectsRoot) {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function validateManifestFile(projectName, fileName, expectedVersion) {
  const manifestPath = path.join(repoRoot, "projects", projectName, fileName)

  const raw = await fs.readFile(manifestPath, "utf8").catch(() => {
    fail(`${projectName}: ${fileName} is missing. Run generation to create it.`)
  })

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    fail(`${projectName}: ${fileName} is not valid JSON.`)
  }

  const context = manifest["@context"]
  if (expectedVersion !== undefined && context !== IIIF_CONTEXTS[expectedVersion]) {
    fail(`${projectName}: ${fileName} @context must be '${IIIF_CONTEXTS[expectedVersion]}'.`)
  }

  if (expectedVersion === undefined && !SUPPORTED_CONTEXTS.has(context)) {
    fail(`${projectName}: ${fileName} @context '${context}' is not a supported IIIF Presentation context.`)
  }

  if (manifest.type !== "Manifest") {
    fail(`${projectName}: ${fileName} type must be 'Manifest'.`)
  }

  if (!manifest.id || typeof manifest.id !== "string") {
    fail(`${projectName}: ${fileName} id is missing.`)
  }

  if (!manifest.label || typeof manifest.label !== "object") {
    fail(`${projectName}: ${fileName} label is missing or invalid.`)
  }

  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    fail(`${projectName}: ${fileName} items must contain at least one Canvas.`)
  }

  for (const [index, canvas] of manifest.items.entries()) {
    if (canvas.type !== "Canvas") {
      fail(`${projectName}: ${fileName} item ${index + 1} is not a Canvas.`)
    }

    if (!Array.isArray(canvas.items) || canvas.items.length === 0) {
      fail(`${projectName}: ${fileName} canvas ${index + 1} is missing AnnotationPage items.`)
    }
  }
}

async function validateProject(projectName) {
  await validateManifestFile(projectName, "manifest.json", undefined)

  for (const version of SUPPORTED_PRESENTATION_VERSIONS) {
    await validateManifestFile(projectName, `manifest-v${version}.json`, version)
  }

  return `${projectName}: OK`
}

async function main() {
  const { all, projectArg } = parseArgs(process.argv)
  const projectsRoot = path.join(repoRoot, "projects")

  let projects = []
  if (all) {
    projects = await listProjectDirectories(projectsRoot)
  } else if (projectArg) {
    projects = [projectArg]
  } else {
    projects = await listProjectDirectories(projectsRoot)
  }

  if (projects.length === 0) {
    console.log("No projects found in projects/. Nothing to validate.")
    return
  }

  for (const projectName of projects) {
    const status = await validateProject(projectName)
    console.log(status)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
