/**
 * Parser for Oracle Primavera P6 XER export.
 * Extracts TASK and TASKPRED tables for Gantt display.
 *
 * Пример сырых строк таблицы TASK в XER (табуляция между полями):
 *
 *   %T	TASK
 *   %F	task_id	task_code	task_name	early_start_date	early_end_date	target_start_date	target_end_date	phys_complete_pct	status_code	wbs_id	...
 *   %R	1001	A-100	Подготовка площадки	2024-01-15 00:00	2024-02-28 00:00	2024-01-15 00:00	2024-02-28 00:00	0	TK_NotStart	10	...
 *   %R	1002	B-200	Фундаментные работы	2024-03-01 00:00	2024-04-15 00:00	2024-03-01 00:00	2024-04-15 00:00	50	TK_Complete	10	...
 *   %R	1003	C-300	Монтаж конструкций	2024-04-16 00:00	2024-06-30 00:00	2024-04-16 00:00	2024-06-30 00:00	0	TK_NotStart	20	...
 *   %E
 *
 * Парсер использует: task_id, task_code, task_name, early_start_date, early_end_date,
 * target_start_date, target_end_date, phys_complete_pct, status_code, wbs_id.
 */

export type XerTask = {
  id: string;
  task_code: string;
  task_name: string;
  start: string; // ISO date
  end: string;
  progress: number; // 0–100
  isCritical?: boolean;
  status_code?: string;
  wbs_id?: string;
  /** Comma-separated resource names from TASKRSRC + RSRC */
  resources?: string;
};

export type XerLink = {
  source: string; // pred_task_id
  target: string; // task_id
  type?: string; // e.g. PR_FS
};

/** WBS element from PROJWBS table (parent_wbs_id empty or 0 = root) */
export type XerWbsNode = {
  id: string;
  parent_wbs_id: string | null;
  wbs_name: string;
  seq_num: number;
};

export type XerSchedule = {
  tasks: XerTask[];
  links: XerLink[];
  wbs: XerWbsNode[];
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

function parseCritical(
  drivingPathValue: string | undefined,
  totalFloatValue: string | undefined
): boolean {
  const driving = String(drivingPathValue ?? '').trim().toUpperCase();
  if (driving === 'Y' || driving === '1' || driving === 'TRUE') return true;
  const totalFloat = parseFloat(String(totalFloatValue ?? '').replace(',', '.'));
  return Number.isFinite(totalFloat) ? totalFloat <= 0 : false;
}

export function parseXer(content: string): XerSchedule {
  const lines = content.split(/\r?\n/);
  const tasks: XerTask[] = [];
  const links: XerLink[] = [];
  const wbs: XerWbsNode[] = [];
  let taskCols: Record<string, number> | null = null;
  let predCols: Record<string, number> | null = null;
  let wbsCols: Record<string, number> | null = null;
  let rsrcCols: Record<string, number> | null = null;
  let taskrsrcCols: Record<string, number> | null = null;

  const rsrcById = new Map<string, string>();
  const resourcesByTaskId = new Map<string, Set<string>>();

  let currentTable: 'TASK' | 'TASKPRED' | 'PROJWBS' | 'RSRC' | 'TASKRSRC' | null = null;
  let readingTask = false;
  let readingPred = false;
  let readingWbs = false;
  let readingRsrc = false;
  let readingTaskrsrc = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split('\t');

    if (parts[0] === '%T') {
      if (parts[1] === 'TASK') currentTable = 'TASK';
      else if (parts[1] === 'TASKPRED') currentTable = 'TASKPRED';
      else if (parts[1] === 'PROJWBS') currentTable = 'PROJWBS';
      else if (parts[1] === 'RSRC') currentTable = 'RSRC';
      else if (parts[1] === 'TASKRSRC') currentTable = 'TASKRSRC';
      else currentTable = null;
      readingTask = false;
      readingPred = false;
      readingWbs = false;
      readingRsrc = false;
      readingTaskrsrc = false;
      continue;
    }

    if (parts[0] === '%F' && parts.length > 1 && currentTable) {
      const headers = parts.slice(1);
      if (currentTable === 'TASK') {
        taskCols = {};
        headers.forEach((h, idx) => { taskCols![h] = idx; });
        readingTask = true;
        readingPred = false;
        readingWbs = false;
        readingRsrc = false;
        readingTaskrsrc = false;
      } else if (currentTable === 'TASKPRED') {
        predCols = {};
        headers.forEach((h, idx) => { predCols![h] = idx; });
        readingPred = true;
        readingTask = false;
        readingWbs = false;
        readingRsrc = false;
        readingTaskrsrc = false;
      } else if (currentTable === 'PROJWBS') {
        wbsCols = {};
        headers.forEach((h, idx) => { wbsCols![h] = idx; });
        readingWbs = true;
        readingTask = false;
        readingPred = false;
        readingRsrc = false;
        readingTaskrsrc = false;
      } else if (currentTable === 'RSRC') {
        rsrcCols = {};
        headers.forEach((h, idx) => { rsrcCols![h] = idx; });
        readingRsrc = true;
        readingTask = false;
        readingPred = false;
        readingWbs = false;
        readingTaskrsrc = false;
      } else if (currentTable === 'TASKRSRC') {
        taskrsrcCols = {};
        headers.forEach((h, idx) => { taskrsrcCols![h] = idx; });
        readingTaskrsrc = true;
        readingTask = false;
        readingPred = false;
        readingWbs = false;
        readingRsrc = false;
      }
      continue;
    }

    if (parts[0] === '%R' && parts.length > 1) {
      const row = parts.slice(1);

      if (readingRsrc && rsrcCols && rsrcCols.rsrc_id !== undefined) {
        const rsrc_id = String(row[rsrcCols.rsrc_id] ?? '').trim();
        const rsrc_name = rsrcCols.rsrc_name !== undefined ? String(row[rsrcCols.rsrc_name] ?? '').trim() : rsrc_id;
        if (rsrc_id) rsrcById.set(rsrc_id, rsrc_name || rsrc_id);
      }

      if (readingTaskrsrc && taskrsrcCols && taskrsrcCols.task_id !== undefined && taskrsrcCols.rsrc_id !== undefined) {
        const task_id = String(row[taskrsrcCols.task_id] ?? '').trim();
        const rsrc_id = String(row[taskrsrcCols.rsrc_id] ?? '').trim();
        if (task_id && rsrc_id) {
          if (!resourcesByTaskId.has(task_id)) resourcesByTaskId.set(task_id, new Set());
          resourcesByTaskId.get(task_id)!.add(rsrc_id);
        }
      }

      if (readingWbs && wbsCols && wbsCols.wbs_id !== undefined) {
        const wbs_id = String(row[wbsCols.wbs_id] ?? '').trim();
        const parent = row[wbsCols.parent_wbs_id];
        const parent_wbs_id = parent === undefined || parent === null || String(parent).trim() === '' || String(parent) === '0' ? null : String(parent).trim();
        const wbs_name = String(row[wbsCols.wbs_name] ?? '').trim();
        const seq_num = Number(row[wbsCols.seq_num]) || 0;
        if (wbs_id) {
          wbs.push({ id: wbs_id, parent_wbs_id, wbs_name, seq_num });
        }
      }

      if (readingTask && taskCols && taskCols.task_id !== undefined) {
        const task_id = row[taskCols.task_id];
        const task_code = row[taskCols.task_code] ?? '';
        const task_name = row[taskCols.task_name] ?? '';
        const early_start = parseDate(row[taskCols.early_start_date]);
        const early_end = parseDate(row[taskCols.early_end_date]);
        const target_start = parseDate(row[taskCols.target_start_date]);
        const target_end = parseDate(row[taskCols.target_end_date]);
        const progress = parsePct(row[taskCols.phys_complete_pct]);
        const driving_path_flag = taskCols.driving_path_flag !== undefined ? row[taskCols.driving_path_flag] : undefined;
        const total_float_hr_cnt = taskCols.total_float_hr_cnt !== undefined ? row[taskCols.total_float_hr_cnt] : undefined;
        const status_code = row[taskCols.status_code];
        const wbs_id = row[taskCols.wbs_id];
        const isCritical = parseCritical(driving_path_flag, total_float_hr_cnt);

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
            isCritical,
            status_code,
            wbs_id: wbs_id != null ? String(wbs_id).trim() : undefined,
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

  tasks.forEach((t) => {
    const rsrcIds = resourcesByTaskId.get(t.id);
    if (rsrcIds && rsrcIds.size > 0) {
      const names = [...rsrcIds].map((id) => rsrcById.get(id) ?? id).sort();
      t.resources = names.join(', ');
    }
  });

  return { tasks, links, wbs };
}
