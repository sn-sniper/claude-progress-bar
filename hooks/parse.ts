export type Sample = {
  fraction?: number
  done?: number
  total?: number
  unit?: 'bytes' | 'items'
  etaSeconds?: number
  /** Bytes per second as the tool itself reported it. */
  rate?: number
  detail?: string
}

const MULTIPLIER: Record<string, number> = {
  B: 1,
  K: 1e3, KB: 1e3, KIB: 2 ** 10, KI: 2 ** 10,
  M: 1e6, MB: 1e6, MIB: 2 ** 20, MI: 2 ** 20,
  G: 1e9, GB: 1e9, GIB: 2 ** 30, GI: 2 ** 30,
  T: 1e12, TB: 1e12, TIB: 2 ** 40, TI: 2 ** 40,
}

const toBytes = (n: string | undefined, unit: string | undefined): number | undefined => {
  const m = unit === undefined ? undefined : MULTIPLIER[unit.toUpperCase()]
  return m === undefined || n === undefined ? undefined : parseFloat(n) * m
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g

const SIZE_PAIR = /(\d+(?:\.\d+)?)\s?([KMGT]i?B?|B)\s*\/\s*(\d+(?:\.\d+)?)\s?([KMGT]i?B?|B)\b/i
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s?%/g
const BRACKET_COUNT = /[[(]\s*(\d+)\s*\/\s*(\d+)\s*[\])]/
const WORD_COUNT = /\b(?:step|phase|stage|item|file|test|task|chunk|part|batch|epoch|package)s?\s+(\d+)\s*(?:\/|of)\s*(\d+)\b/i
const ETA_UNITS = /\bETA[:\s]*((?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/i
const ETA_CLOCK = /\b(?:ETA|remaining|left)[:\s]*(?:(\d+):)?(\d{1,2}):(\d{2})\b/i
const TQDM_REMAINING = /<(?:(\d+):)?(\d{1,2}):(\d{2})[,\]]/
const SPEED = /(\d+(?:\.\d+)?)\s?([KMGT]i?B|B)\/s\b/i
const DD_COPIED = /^(\d+) bytes\b.*\bcopied\b/
// `flutter test` / `dart test`: "01:23 +120 ~2 -1: name". A running count with no total; history supplies one.
const DART_TEST = /^(?:\d+:)?\d{1,2}:\d{2} \+(\d+)(?: ~(\d+))?(?: -(\d+))?:/
// jest/vitest summary: "Tests: 1 failed, 40 passed, 41 total".
const JEST_TOTAL = /^Tests?:?\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed,\s*(\d+) total/i
// cargo: "Building [=====>     ] 120/250: crate".
const CARGO_COUNT = /\]\s+(\d+)\/(\d+)\b/

const unitsToSeconds = (s: string): number | undefined => {
  let total = 0
  let matched = false
  for (const [, n, u] of s.matchAll(/(\d+)([dhms])/g)) {
    matched = true
    total += Number(n) * { d: 86400, h: 3600, m: 60, s: 1 }[u as 'd' | 'h' | 'm' | 's']
  }
  return matched ? total : undefined
}

const clockToSeconds = (h: string | undefined, m: string | undefined, s: string | undefined) =>
  Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)

function parseLine(line: string): Sample | undefined {
  const sample: Sample = {}

  const size = line.match(SIZE_PAIR)
  if (size) {
    const done = toBytes(size[1], size[2])
    const total = toBytes(size[3], size[4])
    if (done !== undefined && total !== undefined && total > 0 && done <= total * 1.01) {
      Object.assign(sample, { done, total, unit: 'bytes', fraction: Math.min(done / total, 1) })
    }
  }

  if (sample.fraction === undefined) {
    const jest = line.match(JEST_TOTAL)
    const count = jest
      ? [line, String(Number(jest[1] ?? 0) + Number(jest[2])), jest[3]]
      : line.match(BRACKET_COUNT) ?? line.match(WORD_COUNT) ?? line.match(CARGO_COUNT)
    if (count) {
      const done = Number(count[1])
      const total = Number(count[2])
      if (total > 0 && done <= total) Object.assign(sample, { done, total, unit: 'items', fraction: done / total })
    }
  }

  // The last percentage on the line is the current one (aria2c prints the sizes first, tqdm the bar after).
  // It beats a size-derived fraction: tools round the sizes they print (aria2c: "8.0GiB/13GiB" is 62%, its own 58% is right).
  const pct = [...line.matchAll(PERCENT)].map(m => parseFloat(m[1] ?? '')).filter(p => p <= 100).at(-1)
  if (pct !== undefined) sample.fraction = pct / 100

  if (sample.fraction === undefined && sample.done === undefined) {
    const dart = line.match(DART_TEST)
    if (dart) Object.assign(sample, { done: Number(dart[1]) + Number(dart[2] ?? 0) + Number(dart[3] ?? 0), unit: 'items' })
  }

  if (sample.fraction === undefined) {
    const dd = line.match(DD_COPIED)
    if (dd) Object.assign(sample, { done: Number(dd[1]), unit: 'bytes' })
  }

  const etaClock = line.match(ETA_CLOCK) ?? line.match(TQDM_REMAINING)
  const etaUnits = line.match(ETA_UNITS)?.[1]
  if (etaClock) sample.etaSeconds = clockToSeconds(etaClock[1], etaClock[2], etaClock[3])
  else if (etaUnits) sample.etaSeconds = unitsToSeconds(etaUnits)

  const speed = line.match(SPEED)
  if (speed) sample.rate = toBytes(speed[1], speed[2])

  return sample.fraction !== undefined || sample.done !== undefined ? sample : undefined
}

/** Progress from the tail of a command's output: the newest line that says anything wins. */
export function parseProgress(text: string): Sample | undefined {
  const lines = text.replace(ANSI, '').split(/[\r\n]+/).map(l => l.trim()).filter(Boolean)
  for (const line of lines.slice(-40).reverse()) {
    const sample = parseLine(line)
    if (sample) return sample
  }
  return undefined
}

export type TaskNotice = { taskId: string; status: string }

export function parseTaskNotices(text: string): TaskNotice[] {
  const notices: TaskNotice[] = []
  for (const [block] of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const taskId = block.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
    const status = block.match(/<status>([^<]+)<\/status>/)?.[1]
    if (taskId && status) notices.push({ taskId: taskId.trim(), status: status.trim() })
  }
  return notices
}

export const parseOutputPath = (text: string | undefined) =>
  text?.match(/Output is being written to: (\S+)/)?.[1]?.replace(/[.,]$/, '')
