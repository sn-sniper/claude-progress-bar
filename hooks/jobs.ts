import type { PlanItem, ProgressJob } from '../types'
import type { Sample } from './parse'

const FINISHED_LINGER_MS = 12_000
const MAX_JOBS = 10
// Weight of the newest instantaneous rate; low enough that one bursty sample doesn't swing the ETA.
const RATE_SMOOTHING = 0.25

export const upsert = (jobs: ProgressJob[], job: ProgressJob): ProgressJob[] =>
  jobs.some(j => j.id === job.id) ? jobs.map(j => (j.id === job.id ? job : j)) : [...jobs, job]

export const patch = (jobs: ProgressJob[], id: string, fn: (job: ProgressJob) => ProgressJob): ProgressJob[] =>
  jobs.map(j => (j.id === id ? fn(j) : j))

export const finish = (job: ProgressJob, status: 'done' | 'failed', now: number): ProgressJob =>
  job.status === 'running'
    ? { ...job, status, finishedAt: now, updatedAt: now, etaSeconds: undefined, fraction: status === 'done' ? 1 : job.fraction }
    : job

export const newJob = (fields: Pick<ProgressJob, 'id' | 'kind' | 'label'> & Partial<ProgressJob>, now: number): ProgressJob => ({
  status: 'running',
  startedAt: now,
  updatedAt: now,
  ...fields,
})

export function applySample(job: ProgressJob, s: Sample, now: number): ProgressJob {
  const next: ProgressJob = { ...job, updatedAt: now }
  if (s.unit) next.unit = s.unit
  if (s.total !== undefined) next.total = s.total
  if (s.done !== undefined) next.done = s.done
  if (s.detail !== undefined) next.detail = s.detail

  const fromCounts = next.done !== undefined && next.total ? Math.min(next.done / next.total, 1) : undefined
  next.fraction = s.fraction ?? fromCounts ?? job.fraction

  // Rate is tracked in the unit the ETA needs: bytes/items when a total is known, else fraction.
  const value = next.unit && next.total ? next.done : next.fraction
  if (value !== undefined) {
    const dt = job.sampleAt === undefined ? 0 : (now - job.sampleAt) / 1000
    if (job.sampleValue !== undefined && dt > 0) {
      if (value < job.sampleValue) {
        next.rate = undefined
      } else {
        const inst = (value - job.sampleValue) / dt
        next.rate = job.rate === undefined ? inst : RATE_SMOOTHING * inst + (1 - RATE_SMOOTHING) * job.rate
      }
    }
    next.sampleAt = now
    next.sampleValue = value
  }
  if (s.rate !== undefined && next.unit === 'bytes') next.rate = s.rate

  const remaining = next.unit && next.total && next.done !== undefined
    ? next.total - next.done
    : next.fraction !== undefined ? 1 - next.fraction : undefined
  const computed = remaining !== undefined && next.rate ? remaining / next.rate : undefined
  next.etaSeconds = s.etaSeconds ?? computed
  return next
}

/** One job for the whole task list: completed/total, the in-progress item as detail, ETA from the average step. */
export function planJob(prev: ProgressJob | undefined, items: PlanItem[], now: number): ProgressJob | undefined {
  if (items.length === 0) return prev && finish(prev, 'done', now)
  const done = items.filter(i => i.status === 'completed').length
  const current = items.find(i => i.status === 'in_progress')
  const base = prev && prev.status === 'running' ? prev : newJob({ id: 'plan', kind: 'plan', label: 'Plan' }, now)
  const perStep = done > 0 ? (now - base.startedAt) / 1000 / done : undefined
  const job: ProgressJob = {
    ...base,
    updatedAt: now,
    done,
    total: items.length,
    unit: 'items',
    fraction: done / items.length,
    detail: current ? (current.activeForm ?? current.subject) : undefined,
    etaSeconds: perStep === undefined ? undefined : perStep * (items.length - done),
  }
  return done === items.length ? finish(job, 'done', now) : job
}

export const isVisible = (job: ProgressJob, now: number, others: ProgressJob[]): boolean => {
  if (job.kind === 'tool') return job.status === 'running' && now - job.startedAt >= 3000
  if (job.kind === 'turn') return now - job.startedAt >= 2000 && !others.some(o => o.kind !== 'turn' && o.status === 'running')
  return true
}

export const prune = (jobs: ProgressJob[], now: number): ProgressJob[] =>
  jobs
    .filter(j => j.status === 'running' || now - (j.finishedAt ?? now) < FINISHED_LINGER_MS)
    .slice(-MAX_JOBS)
