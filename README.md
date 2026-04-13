# Github Manifests

Generate and publish IIIF Presentation 3 manifests for TPEN3 and IIIF viewers such as Mirador.

## Purpose

This repository is designed for low-friction manifest creation:

- Add images or URL link files to a project folder
- Optionally customize metadata in info.yml
- Run one command (or let GitHub Actions run it)
- Use the generated manifest URL in TPEN3, Mirador, or other IIIF viewers

## Repository Layout

```text
.
├── projects/
│   ├── example-project/
│   │   ├── images/
│   │   ├── info.yml
│   │   ├── manifest.json      # generated
│   │   ├── README.md          # generated
│   │   └── WARNING.md         # generated
├── scripts/
│   ├── config.js
│   ├── generate.js
│   └── validate.js
└── .github/workflows/generate-manifests.yml
```

<!-- GENERATED_PROJECT_LINKS_START -->
## Projects

- [example-project](./projects/example-project/)
<!-- GENERATED_PROJECT_LINKS_END -->

## Project Inputs

Each project lives in `projects/{project-name}`.

Required:

- images/ folder (may contain local images and/or .lnk files)

Optional:

- info.yml for metadata, ordering, and top-level IIIF fields

Supported external resource methods:

1. .lnk files in images/ where file contents are a single HTTP(S) URL
2. resources list in info.yml for explicit ordering and richer control

## Ordering Rules

Ordering priority is:

1. resources entries in info.yml (by order, then natural file/url sort)
2. remaining local images and .lnk files in natural filename order

## Metadata Policy

Metadata is optional.

When provided:

- metadata entries are normalized to IIIF Presentation 3 label/value language-map objects
- only recognized top-level IIIF fields are mapped directly (for example, service/services and seeAlso)
- custom fields must be added as metadata entries in info.yml rather than arbitrary top-level keys

Reference guidance:

- [Metadata on any Resource](https://iiif.io/api/cookbook/recipe/0029-metadata-anywhere/)
- [IIIF Presentation 3 Metadata](https://iiif.io/api/presentation/3.0/#metadata)

## Warning Policy

Generation is non-blocking and warns for:

- image width or height greater than 5000 px
- file size greater than 15 MB
- unsupported media types in repository workflow (even if valid in IIIF)
- missing rights statements
- unreachable external URLs (GET check)

Warnings are written to project WARNING.md.

## Regeneration Policy

Generated files are always overwritten on each run:

- manifest.json
- README.md
- WARNING.md

Keep durable customizations in info.yml or generation templates, not directly in generated files.

## Local Usage

Install dependencies:

```bash
npm install
```

Generate all projects:

```bash
npm run generate:all
```

Generate one project:

```bash
npm run generate -- example-project
```

Validate all generated manifests:

```bash
npm run validate:all
```

## GitHub Actions and Pages

Workflow:

- .github/workflows/generate-manifests.yml

On push to main, the workflow:

1. installs dependencies
2. regenerates manifests
3. validates outputs
4. commits generated files back to main when changed

### Workflow Control Markers

To reduce unnecessary workflow runs, commit messages can include these markers:

- `[skip manifests]` or `[skip ci]`: skip the manifest workflow on push
- `[manifests-local]`: skip the initial generate step, run validation, then verify generated outputs are already current

`[manifests-local]` is intended for commits where you already ran generation locally and committed generated files. If committed outputs are stale, CI fails and reports drift.

GitHub Pages should be configured to publish from the main branch.

Manifest URL pattern:

- `https://{owner}.github.io/{repo}/projects/{project-name}/manifest.json`

## TPEN3 and Viewer Use

1. Copy a generated manifest URL.
2. Import that URL into TPEN3 new project creation.
3. Open the same URL in viewers such as Mirador for review.

Mirador launch pattern:

- [Mirador Embed](https://projectmirador.org/embed/?iiif-content={manifest-url})

## License and Rights Notes

The repository LICENSE does not replace per-manifest rights metadata.
Add rights statements in each project info.yml where possible.

## Performance Notes

Very large image files can degrade loading and interaction in TPEN3 and IIIF viewers. Prefer web-optimized derivatives when practical.
