import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs, repoRoot } from "./utils.js"

function fail(message) {
  throw new Error(message)
}

async function listProjectDirectories(projectsRoot) {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function validateProject(projectName) {
  const projectDir = path.join(repoRoot, "projects", projectName)
  const manifestPath = path.join(projectDir, "manifest.json")

  const raw = await fs.readFile(manifestPath, "utf8")
  const manifest = JSON.parse(raw)

  if (manifest.type !== "Manifest") {
    fail(`${projectName}: manifest type must be 'Manifest'.`)
  }

  if (!manifest.id || typeof manifest.id !== "string") {
    fail(`${projectName}: manifest id is missing.`)
  }

  if (!manifest.label || typeof manifest.label !== "object") {
    fail(`${projectName}: manifest label is missing or invalid.`)
  }

  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    fail(`${projectName}: manifest items must contain at least one Canvas.`)
  }

  for (const [index, canvas] of manifest.items.entries()) {
    if (canvas.type !== "Canvas") {
      fail(`${projectName}: item ${index + 1} is not a Canvas.`)
    }

    if (!Array.isArray(canvas.items) || canvas.items.length === 0) {
      fail(`${projectName}: canvas ${index + 1} is missing AnnotationPage items.`)
    }
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
