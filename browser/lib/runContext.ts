export function makeRunId(prefix = 'run'): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${stamp}-${rand}`
}
