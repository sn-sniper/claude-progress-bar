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
  /** Shell snippet whose stdout's first number is the current `done`. */
  probe?: string
}

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
