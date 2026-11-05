const conflictMarkerRegex = /^(<{7}|={7}|>{7}|\|{7})(\s|$)/m

/** Returns true if the text still contains Git conflict markers */
export function hasConflictMarkers(text: string) {
  return conflictMarkerRegex.test(text)
}
