/** How this fork handles new releases */
export type ForkUpdateMode = 'auto' | 'notify'

const modeKey = 'fork-update-mode'

/** Event the preferences fire to check for updates right away */
export const CheckForUpdatesNowEvent = 'fork-update-check-now'

export function getForkUpdateMode(): ForkUpdateMode {
  try {
    return localStorage.getItem(modeKey) === 'notify' ? 'notify' : 'auto'
  } catch {
    return 'auto'
  }
}

export function setForkUpdateMode(mode: ForkUpdateMode) {
  try {
    localStorage.setItem(modeKey, mode)
  } catch {
    // Not critical
  }
}
