const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const spinner = (tick: number) => SPINNER[tick % SPINNER.length]

export function bar(fraction: number, width: number): [string, string] {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * width)
  return ['█'.repeat(filled), '░'.repeat(width - filled)]
}

/** A short block sweeping back and forth: for work with no measurable end. */
export function bounce(tick: number, width: number): [string, string, string] {
  const block = Math.max(2, Math.floor(width / 6))
  const span = Math.max(1, width - block)
  const step = tick % (span * 2)
  const at = step < span ? step : span * 2 - step
  return ['░'.repeat(at), '█'.repeat(block), '░'.repeat(width - block - at)]
}

export function fmtBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Pads or cuts to exactly `width` cells, marking a cut with an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const chars = [...text]
  return chars.length > width ? chars.slice(0, width - 1).join('') + '…' : text.padEnd(width)
}
