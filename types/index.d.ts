export type JobKind = 'shell' | 'workflow' | 'plan' | 'agent' | 'tool' | 'turn' | 'report'
export type JobStatus = 'running' | 'done' | 'failed'

export type ProgressJob = {
  id: string
  kind: JobKind
  label: string
  status: JobStatus
  startedAt: number
  updatedAt: number
  finishedAt?: number
  /** 0..1 once anything says how far along it is; absent means indeterminate. */
  fraction?: number
  done?: number
  total?: number
  unit?: 'bytes' | 'items'
  /** Units per second for bytes/items, fraction per second otherwise; smoothed. */
  rate?: number
  /** Last sample, to derive the next rate. */
  sampleAt?: number
  sampleValue?: number
  etaSeconds?: number
  detail?: string
  outputFile?: string
  /** File whose size (or line count) is the current `done`, set through the report tool. */
  watch?: string
  measure?: 'bytes' | 'lines'
  /** The fraction is a guess from earlier runs' timings, not something the work printed. */
  isEstimate?: boolean
  /** A background command split into the steps of its `&&`/`;` chain. */
  steps?: Step[]
  /** Index into `steps` of the one running now. */
  step?: number
  /** History key: the same command run again finds its past timings under it. */
  historyKey?: string
  /** Per step label: when it was first seen running and the largest count it printed. */
  observed?: Record<string, { startedAt: number; done?: number }>
}

export type Step = {
  label: string
  /** Files the step redirects or tees into; read alongside the task's own output. */
  logs: string[]
  /** Literal text an `echo` right after the step prints: seeing it means the step is over. */
  marker?: string
}

export type StepHistory = { ms: number; total?: number }
/** Remembered timings of one command shape; `at` is when it last finished, for trimming the oldest. */
export type RunHistory = { ms: number; steps: Record<string, StepHistory>; runs: number; at?: number }

export type PlanItem = { subject: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': {
      jobs: ProgressJob[]
      /** TaskCreate/TaskUpdate list, keyed by task id. */
      tasks: Record<string, PlanItem>
      isHidden: boolean
      /** Wall clock of the last tick; drawings read it for elapsed time and spinners. */
      now: number
    }
  }
}
