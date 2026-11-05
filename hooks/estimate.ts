import type { ProgressJob, RunHistory } from '../types'
import { parseProgress } from './parse'
import type { Sample } from './parse'

/** What one poll saw of a shell job: its output's tail, and each step log's stat and tail. */
export type Seen = {
  output?: string
  logs: Record<string, { mtimeMs: number; size: number; text?: string } | undefined>
}

// An estimate never claims the work is finished; only the completion notice does.
const CAP = 0.99
const MAX_HISTORY = 200
// Weight of the newest run in the remembered timings: recent enough to follow a growing test suite.
const NEWEST_RUN = 0.5

const clamp = (f: number) => Math.min(Math.max(f, 0), CAP)

/** Index of the step running now: the furthest one whose log is being written or whose predecessor's marker printed. */
export function currentStep(job: ProgressJob, seen: Seen): number {
  const steps = job.steps ?? []
  let at = job.step ?? 0
  steps.forEach((step, i) => {
    if (step.marker && seen.output?.includes(step.marker)) at = Math.max(at, i + 1)
    // `>` truncates at the step's start, so a log touched since the job began belongs to this run.
    const isWriting = step.logs.some(l => {
      const s = seen.logs[l]
      return s !== undefined && s.size > 0 && s.mtimeMs >= job.startedAt - 1000
    })
    if (isWriting) at = Math.max(at, i)
  })
  return Math.min(at, Math.max(steps.length - 1, 0))
}

/**
 * The text a step printed: its own logs, else the stretch of the task output between the previous step's
 * marker and its own. Without markers the whole output is the best there is; its newest lines win anyway.
 */
export function stepText(job: ProgressJob, seen: Seen, i: number): string {
  const step = job.steps?.[i]
  const logs = step?.logs.map(l => seen.logs[l]?.text).filter((t): t is string => t !== undefined) ?? []
  if (logs.length > 0) return logs.join('\n')
  const output = seen.output ?? ''
  const prev = job.steps?.[i - 1]?.marker
  const from = prev ? output.indexOf(prev) : -1
  const start = from === -1 ? 0 : from + prev!.length
  const to = step?.marker ? output.indexOf(step.marker, start) : -1
  return output.slice(start, to === -1 ? undefined : to)
}

/** The largest item count each step printed, by label: what a finished run teaches the next one. */
export function stepCounts(job: ProgressJob, seen: Seen): Record<string, number> {
  const counts: Record<string, number> = {}
  job.steps?.forEach((step, i) => {
    const s = parseProgress(stepText(job, seen, i))
    const n = s?.unit === 'items' ? s.total ?? s.done : undefined
    if (n !== undefined) counts[step.label] = n
  })
  return counts
}

type Estimate ={ sample: Sample; isEstimate: boolean; step?: number; observed?: ProgressJob['observed'] }

/**
 * Turns one poll into a sample. Within a step: the step's own printed progress, else its count over the
 * count it reached last time, else its elapsed time over last time's duration. Across steps: completed
 * steps plus the current one's share, weighted by past durations when every step has one.
 */
export function estimate(job: ProgressJob, seen: Seen, history: RunHistory | undefined, now: number): Estimate {
  const steps = job.steps ?? []
  const at = currentStep(job, seen)
  const step = steps[at]

  const observed = { ...job.observed }
  if (step && observed[step.label] === undefined) observed[step.label] = { startedAt: at === 0 ? job.startedAt : now }

  const printed = parseProgress(steps.length > 0 ? stepText(job, seen, at) : seen.output ?? '')

  const past = step ? history?.steps[step.label] : undefined
  const stepStart = step ? observed[step.label]!.startedAt : job.startedAt
  if (step && printed?.done !== undefined && printed.unit === 'items') {
    observed[step.label] = { ...observed[step.label]!, done: Math.max(printed.done, observed[step.label]!.done ?? 0) }
  }

  let inner: number | undefined
  let isEstimate = false
  if (printed?.fraction !== undefined) inner = printed.fraction
  else if (printed?.done !== undefined && printed.unit === 'items' && past?.total) {
    inner = clamp(printed.done / past.total)
    isEstimate = true
  } else if (past?.ms) {
    inner = clamp((now - stepStart) / past.ms)
    isEstimate = true
  }

  const elapsed = now - job.startedAt
  let fraction: number | undefined
  let etaSeconds = printed?.etaSeconds
  if (steps.length > 1) {
    const durations = steps.map(s => history?.steps[s.label]?.ms)
    const hasAll = durations.every(d => d !== undefined && d > 0)
    const weights = hasAll ? (durations as number[]) : steps.map(() => 1)
    const sum = weights.reduce((a, b) => a + b, 0)
    const before = weights.slice(0, at).reduce((a, b) => a + b, 0)
    fraction = clamp((before + (inner ?? 0) * weights[at]!) / sum)
    if (hasAll) isEstimate = true
    if (etaSeconds === undefined && hasAll) {
      const left = weights[at]! * (1 - (inner ?? 0)) + weights.slice(at + 1).reduce((a, b) => a + b, 0)
      etaSeconds = left / 1000
    }
  } else if (inner !== undefined) {
    fraction = printed?.fraction !== undefined ? printed.fraction : inner
    if (etaSeconds === undefined && isEstimate && past?.ms) etaSeconds = Math.max(0, past.ms * (1 - inner)) / 1000
  } else if (history?.ms) {
    fraction = clamp(elapsed / history.ms)
    isEstimate = true
    etaSeconds = Math.max(0, history.ms - elapsed) / 1000
  }

  const count = printed?.unit === 'items' && printed.done !== undefined
    ? ` ${printed.done}${printed.total ?? past?.total ? `/${printed.total ?? past?.total}` : ''}`
    : ''
  const where = steps.length > 1 && step ? `step ${at + 1}/${steps.length}: ${step.label}${count}` : undefined

  // A single step keeps its printed sizes and counts, so bytes/speed still show; a chain shows them in the detail.
  const sample: Sample = steps.length > 1
    ? { fraction, etaSeconds, detail: where }
    : { ...printed, fraction, etaSeconds }
  if (sample.fraction === undefined && sample.done === undefined && !where) return { sample: {}, isEstimate: false, step: at, observed }
  return { sample, isEstimate, step: at, observed }
}

/** Folds a successful run into its key's remembered timings. Steps whose start was not seen are skipped. */
export function recordRun(prev: RunHistory | undefined, job: ProgressJob, finishedAt: number, counts: Record<string, number> = {}): RunHistory {
  const blend = (old: number | undefined, value: number) => (old === undefined ? value : old * (1 - NEWEST_RUN) + value * NEWEST_RUN)
  const steps = { ...prev?.steps }
  const order = job.steps ?? []
  order.forEach((step, i) => {
    const old = steps[step.label]
    const total = counts[step.label] ?? job.observed?.[step.label]?.done ?? old?.total
    const seen = job.observed?.[step.label]
    // A step ends where the next one was first seen; without that sighting its duration is unknown, and a
    // step first seen at the finish (polls missed it) has none either.
    const end = i === order.length - 1 ? finishedAt : job.observed?.[order[i + 1]!.label]?.startedAt
    const ms = seen && end !== undefined && end > seen.startedAt ? blend(old?.ms, end - seen.startedAt) : old?.ms
    if (ms !== undefined || total !== undefined) steps[step.label] = { ms: ms ?? 0, total }
  })
  return { ms: blend(prev?.ms, finishedAt - job.startedAt), steps, runs: (prev?.runs ?? 0) + 1, at: finishedAt }
}

/** Keeps the store bounded: the least recently finished keys go first. */
export function trimHistory(all: Record<string, RunHistory>): Record<string, RunHistory> {
  const keys = Object.keys(all)
  if (keys.length <= MAX_HISTORY) return all
  const keep = keys.sort((a, b) => (all[b]!.at ?? 0) - (all[a]!.at ?? 0)).slice(0, MAX_HISTORY)
  return Object.fromEntries(keep.map(k => [k, all[k]!]))
}
