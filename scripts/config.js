export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
  ".gif",
  ".jp2"
])

export const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/gif",
  "image/jp2"
])

export const MAX_IMAGE_DIMENSION_WARNING = 5000
export const MAX_FILE_SIZE_WARNING_BYTES = 15 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 15000

export const IIIF_CONTEXTS = {
  3: "http://iiif.io/api/presentation/3/context.json",
  4: "http://iiif.io/api/presentation/4/context.json"
}

export const SUPPORTED_PRESENTATION_VERSIONS = Object.keys(IIIF_CONTEXTS).map(Number)
export const DEFAULT_PRESENTATION_VERSION = 3

export const TOP_LEVEL_ALLOWED_INFO_KEYS = new Set([
  "label",
  "summary",
  "requiredStatement",
  "rights",
  "provider",
  "metadata",
  "homepage",
  "rendering",
  "service",
  "services",
  "seeAlso",
  "behavior",
  "viewingDirection",
  "navDate",
  "start",
  "thumbnail",
  "resources",
  "ordering",
  "presentationVersion"
])
