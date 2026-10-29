// Keep this release constant equal to the exact package dependency (checked in
// doctor.test.js). The host import path does not need to resolve package.json
// subpaths just to construct a repair instruction.
export const playwrightVersion = '1.63.0'
// DSH workspaces often do not contain this plugin's package.json. Bare npx
// there can select a newer CLI and download an incompatible browser revision.
export const browserInstallCommand = `npx --yes --package=playwright@${playwrightVersion} playwright install chromium-headless-shell`
