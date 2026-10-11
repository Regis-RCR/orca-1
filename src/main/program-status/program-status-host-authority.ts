/**
 * Whether this process is the desktop app's own main process, the one host that arms OSC 7501.
 *
 * Why a claim and not a test of the argv: the spawn builders are shared with every host that
 * serves PTYs (the Node `orcad` server, Electron `--serve`), and each one spells its launch
 * differently. Only the desktop startup claims this, once it knows it is not serving, so a host
 * that never claims it, a future headless entry included, stays unarmed by default.
 */
let desktopHostClaimed = false

export function claimProgramStatusDesktopHost(): void {
  desktopHostClaimed = true
}

export function isProgramStatusDesktopHost(): boolean {
  return desktopHostClaimed
}

export function resetProgramStatusDesktopHostForTests(): void {
  desktopHostClaimed = false
}
