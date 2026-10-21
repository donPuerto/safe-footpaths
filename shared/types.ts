// Rows as they come back from the Google Sheet tabs (via the n8n "sf-plan" webhook).
// Sheet values arrive as strings or numbers, so fields are loose on purpose.
type Cell = string | number

export interface RankedRow {
  rank: Cell; job: Cell; organisation: string; suburb: string; sector: string; status: string
  techs: Cell; days: Cell; rule: string; reason: string; planned: string; approval: string
}
export interface PlanRow {
  day: string; day_label: string; crew: string; crew_names: string; job: Cell; organisation: string
  suburb: string; techs: Cell; days: Cell; part: string; source: string; reason: string
}
export interface NeedsHumanRow { job: Cell; type: string; reason: string }
export interface CheckRow { check: string; result: string; detail: string; run_at: string }
export interface RunRow { run_at: string; ok: string; jobs: Cell; placed: Cell; needs_human: Cell; rule_order: string }
export interface OverrideRow { job: Cell; action: string; crew: string; day: string; updated_by: string; updated_at: string }
export interface SettingRow { key: string; value: Cell }

export interface PlanData {
  ranked: RankedRow[]
  plan: PlanRow[]
  needsHuman: NeedsHumanRow[]
  checks: CheckRow[]
  runs: RunRow[]
  overrides: OverrideRow[]
  settings: SettingRow[]
}

export interface OverrideRequest {
  job: string
  action: 'lock' | 'move' | 'unlock'
  crew?: 'A' | 'B' | 'A+B'
  day?: string
  passcode: string
}
