/**
 * Parser for Oracle Primavera P6 XER export.
 * Extracts TASK and TASKPRED tables for Gantt display.
 */

export type XerTask = {
  id: string;
  task_code: string;
  task_name: string;
  start: string; // ISO date
  end: string;
  progress: number; // 0–100
  status_code?: string;
  wbs_id?: string;
};

export type XerLink = {
  source: string; // pred_task_id
  target: string; // task_id
  type?: string; // e.g. PR_FS
};

export type XerSchedule = {
  tasks: XerTask[];
  links: XerLink[];
  projectName?: string;
};

function parseDate(s: string): string | null {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[\sT](\d{2})?:?(\d{2})?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function parsePct(s: string): number {
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

export function parseXer(content: string): XerSchedule {
  const lines = content.split(/\r?\n/);
  const tasks: XerTask[] = [];
  const links: XerLink[] = [];
  let taskCols: Record<string, number> | null = null;
  let predCols: Record<string, number> | null = null;

  let currentTable: 'TASK' | 'TASKPRED' | null = null;
  let readingTask = false;
  let readingPred = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split('\t');

    if (parts[0] === '%T') {
      if (parts[1] === 'TASK') currentTable = 'TASK';
      else if (parts[1] === 'TASKPRED') currentTable = 'TASKPRED';
      else currentTable = null;
      readingTask = false;
      readingPred = false;
      continue;
    }

    if (parts[0] === '%F' && parts.length > 1 && currentTable) {
      const headers = parts.slice(1);
      if (currentTable === 'TASK') {
        taskCols = {};
        headers.forEach((h, idx) => { taskCols![h] = idx; });
        readingTask = true;
        readingPred = false;
      } else if (currentTable === 'TASKPRED') {
        predCols = {};
        headers.forEach((h, idx) => { predCols![h] = idx; });
        readingPred = true;
        readingTask = false;
      }
      continue;
    }

    if (parts[0] === '%R' && parts.length > 1) {
      const row = parts.slice(1);

      if (readingTask && taskCols && taskCols.task_id !== undefined) {
        const task_id = row[taskCols.task_id];
        const task_code = row[taskCols.task_code] ?? '';
        const task_name = row[taskCols.task_name] ?? '';
        const early_start = parseDate(row[taskCols.early_start_date]);
        const early_end = parseDate(row[taskCols.early_end_date]);
        const target_start = parseDate(row[taskCols.target_start_date]);
        const target_end = parseDate(row[taskCols.target_end_date]);
        const progress = parsePct(row[taskCols.phys_complete_pct]);
        const status_code = row[taskCols.status_code];
        const wbs_id = row[taskCols.wbs_id];

        const start = early_start || target_start;
        const end = early_end || target_end;
        if (task_id && start && end) {
          tasks.push({
            id: String(task_id),
            task_code: String(task_code).trim(),
            task_name: String(task_name).trim(),
            start,
            end,
            progress,
            status_code,
            wbs_id,
          });
        }
      }

      if (readingPred && predCols && predCols.task_id !== undefined) {
        const task_id = row[predCols.task_id];
        const pred_task_id = row[predCols.pred_task_id];
        const pred_type = row[predCols.pred_type];
        if (task_id && pred_task_id) {
          links.push({
            source: String(pred_task_id),
            target: String(task_id),
            type: pred_type,
          });
        }
      }
    }
  }

  return { tasks, links };
}
