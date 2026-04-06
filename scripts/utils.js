import fs from "node:fs/promises"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const repoRoot = path.resolve(__dirname, "..")

export function toPosixPath(value) {
  return value.split(path.sep).join("/")
}

export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

export function languageMapFrom(value, fallbackLang = "none") {
  if (value == null) {
    return undefined
  }

  if (typeof value === "string") {
    return { [fallbackLang]: [value] }
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return { [fallbackLang]: [String(value)] }
  }

  if (Array.isArray(value)) {
    const normalized = value
      .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      .map((item) => String(item))
    return normalized.length > 0 ? { [fallbackLang]: normalized } : undefined
  }

  if (typeof value === "object") {
    const output = {}

    for (const [lang, entries] of Object.entries(value)) {
      if (typeof entries === "string") {
        output[lang] = [entries]
        continue
      }

      if (typeof entries === "number" || typeof entries === "boolean") {
        output[lang] = [String(entries)]
        continue
      }

      if (Array.isArray(entries)) {
        const normalized = entries
          .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
          .map((item) => String(item))
        if (normalized.length > 0) {
          output[lang] = normalized
        }
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  return undefined
}

export function metadataFromInfo(infoMetadata) {
  if (!Array.isArray(infoMetadata)) {
    return []
  }

  const metadata = []
  for (const entry of infoMetadata) {
    if (!entry || typeof entry !== "object") {
      continue
    }

    const label = languageMapFrom(entry.label)
    const value = languageMapFrom(entry.value)
    if (!label || !value) {
      continue
    }

    metadata.push({ label, value })
  }

  return metadata
}

export async function readYamlFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    const parsed = yaml.load(raw)
    if (parsed && typeof parsed === "object") {
      return parsed
    }
    return {}
  } catch (error) {
    if (error.code === "ENOENT") {
      return {}
    }
    throw error
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function writeJson(filePath, value) {
  const payload = JSON.stringify(value, null, 2) + "\n"
  await fs.writeFile(filePath, payload, "utf8")
}

export async function writeText(filePath, text) {
  await fs.writeFile(filePath, text, "utf8")
}

export function getRepoSlugFromEnv() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY
  }

  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()

    const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
    if (httpsMatch) {
      return `${httpsMatch[1]}/${httpsMatch[2]}`
    }

    const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)
    if (sshMatch) {
      return `${sshMatch[1]}/${sshMatch[2]}`
    }
  } catch {
    return ""
  }

  return ""
}

export function buildSiteBaseUrl() {
  const fromEnv = process.env.SITE_BASE_URL
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "")
  }

  const repoSlug = getRepoSlugFromEnv()
  if (!repoSlug.includes("/")) {
    return "https://example.org"
  }

  const [owner, repo] = repoSlug.split("/")
  return `https://${owner}.github.io/${repo}`
}

export function parseArgs(argv) {
  const rawArgs = argv.slice(2)
  const args = new Set(rawArgs)
  const positional = rawArgs.filter((arg) => !arg.startsWith("-"))

  return {
    all: args.has("--all"),
    projectArg: positional[0]
  }
}
