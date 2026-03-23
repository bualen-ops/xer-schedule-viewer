'use client';

import { useCallback, useMemo, useState } from 'react';
import { parseXer, type XerSchedule, type XerTask, type XerWbsNode } from '@/lib/xerParser';

const DISPLAY_LIMIT = 500;
/** Подписей дат не больше 8, чтобы не налезали в узкой области графика (520px) */
const MAX_TIMELINE_LABELS = 8;

/** Пресет периода для отбора работ (пересечение с [start, end]). */
type PeriodPreset = 'all' | 'week' | 'month' | 'year';

function toLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Понедельник–воскресенье (локальный календарь), неделя содержит anchor. */
function weekBoundsFromAnchor(anchor: Date): { start: string; end: string } {
  const x = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const dow = x.getDay();
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + offsetToMonday);
  const start = new Date(x);
  const end = new Date(x);
  end.setDate(end.getDate() + 6);
  return { start: toLocalYmd(start), end: toLocalYmd(end) };
}

function monthBoundsFromAnchor(anchor: Date): { start: string; end: string } {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  return { start: toLocalYmd(start), end: toLocalYmd(end) };
}

function yearBoundsFromAnchor(anchor: Date): { start: string; end: string } {
  const y = anchor.getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

function getPeriodBounds(preset: PeriodPreset, anchor: Date): { start: string; end: string } | null {
  if (preset === 'all') return null;
  if (preset === 'week') return weekBoundsFromAnchor(anchor);
  if (preset === 'month') return monthBoundsFromAnchor(anchor);
  return yearBoundsFromAnchor(anchor);
}

/** Работа попадает в период, если пересекается с интервалом по датам YYYY-MM-DD. */
function taskOverlapsPeriod(task: XerTask, start: string, end: string): boolean {
  return task.end >= start && task.start <= end;
}

function filterTasksByPeriod(tasks: XerTask[], preset: PeriodPreset, anchor: Date): XerTask[] {
  const bounds = getPeriodBounds(preset, anchor);
  if (!bounds) return tasks;
  return tasks.filter((t) => taskOverlapsPeriod(t, bounds.start, bounds.end));
}

function todayYmd(): string {
  return toLocalYmd(new Date());
}

type GanttRowItem =
  | { type: 'wbs'; wbs: XerWbsNode; level: number; hasChildren: boolean; spanStart?: string; spanEnd?: string }
  | { type: 'task'; task: XerTask; level: number };

function buildWbsTree(schedule: XerSchedule) {
  const { wbs, tasks } = schedule;
  const wbsById = new Map<string, XerWbsNode>();
  wbs.forEach((n) => wbsById.set(n.id, n));
  const childrenByParent = new Map<string, XerWbsNode[]>();
  wbs.forEach((n) => {
    const pid = n.parent_wbs_id ?? '';
    const key = pid === '0' ? '' : pid;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(n);
  });
  childrenByParent.forEach((arr) => arr.sort((a, b) => a.seq_num - b.seq_num || a.id.localeCompare(b.id)));
  let roots = (childrenByParent.get('') ?? []).sort((a, b) => a.seq_num - b.seq_num || a.id.localeCompare(b.id));
  if (roots.length === 0 && wbs.length > 0) {
    roots = wbs
      .filter((n) => !n.parent_wbs_id || n.parent_wbs_id === '0' || !wbsById.has(n.parent_wbs_id))
      .sort((a, b) => a.seq_num - b.seq_num || a.id.localeCompare(b.id));
  }
  const tasksByWbs = new Map<string, XerTask[]>();
  tasks.forEach((t) => {
    const wid = t.wbs_id ?? '';
    if (!tasksByWbs.has(wid)) tasksByWbs.set(wid, []);
    tasksByWbs.get(wid)!.push(t);
  });
  tasksByWbs.forEach((arr) => arr.sort((a, b) => a.start.localeCompare(b.start)));
  const wbsSpan = new Map<string, { start: string; end: string }>();
  function span(wbsId: string): { start: string; end: string } {
    if (wbsSpan.has(wbsId)) return wbsSpan.get(wbsId)!;
    const tasks = tasksByWbs.get(wbsId) ?? [];
    const childIds = (childrenByParent.get(wbsId) ?? []).map((c) => c.id);
    let start = '';
    let end = '';
    tasks.forEach((t) => {
      if (!start || t.start < start) start = t.start;
      if (!end || t.end > end) end = t.end;
    });
    childIds.forEach((cid) => {
      const s = span(cid);
      if (s.start && (!start || s.start < start)) start = s.start;
      if (s.end && (!end || s.end > end)) end = s.end;
    });
    const r = { start, end };
    wbsSpan.set(wbsId, r);
    return r;
  }
  wbs.forEach((n) => span(n.id));
  return { wbsById, childrenByParent, roots, tasksByWbs, wbsSpan };
}

function buildVisibleRows(
  schedule: XerSchedule,
  expandedIds: Set<string>
): GanttRowItem[] {
  const { wbs, tasks } = schedule;
  if (wbs.length === 0) {
    return tasks.slice(0, DISPLAY_LIMIT).map((task) => ({ type: 'task' as const, task, level: 0 }));
  }
  const { childrenByParent, roots, tasksByWbs, wbsSpan } = buildWbsTree(schedule);
  const out: GanttRowItem[] = [];
  function add(wbsNode: XerWbsNode, level: number) {
    const childWbs = childrenByParent.get(wbsNode.id) ?? [];
    const directTasks = tasksByWbs.get(wbsNode.id) ?? [];
    const hasChildren = childWbs.length > 0 || directTasks.length > 0;
    const span = wbsSpan.get(wbsNode.id);
    out.push({
      type: 'wbs',
      wbs: wbsNode,
      level,
      hasChildren,
      spanStart: span?.start,
      spanEnd: span?.end,
    });
    if (!expandedIds.has(wbsNode.id)) return;
    directTasks.forEach((task) => out.push({ type: 'task', task, level: level + 1 }));
    childWbs.forEach((ch) => add(ch, level + 1));
  }
  roots.forEach((r) => add(r, 0));
  const seenWbs = new Set(wbs.map((n) => n.id));
  const orphanWbsIds = [...tasksByWbs.keys()].filter((wid) => wid && !seenWbs.has(wid));
  orphanWbsIds.forEach((wid) => {
    (tasksByWbs.get(wid) ?? []).forEach((task) => out.push({ type: 'task', task, level: 0 }));
  });
  return out.slice(0, DISPLAY_LIMIT);
}

function daysBetween(start: string, end: string): number {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function formatDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** CSV for Excel: semicolon separator, UTF-8 BOM, fields quoted if contain ; or " */
function buildScheduleCsv(tasks: XerTask[]): string {
  const sep = ';';
  const escape = (v: string) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };
  const header = ['ID', 'Код', 'Название', 'Начало', 'Окончание', 'Длительность (дн.)', 'Ресурсы', 'Прогресс %'].join(sep);
  const rows = tasks.map((t) => {
    const duration = daysBetween(t.start, t.end);
    return [
      t.id,
      t.task_code ?? '',
      t.task_name ?? '',
      t.start,
      t.end,
      String(duration),
      t.resources ?? '',
      String(t.progress),
    ].map(escape).join(sep);
  });
  return '\uFEFF' + [header, ...rows].join('\r\n');
}

function downloadCsv(tasks: XerTask[]) {
  const csv = buildScheduleCsv(tasks);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `schedule_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const INDENT_PX = 20;

function GanttTaskRow({
  t,
  level,
  rowNum,
  leftPct,
  widthPct,
  isCritical,
}: {
  t: XerTask;
  level: number;
  rowNum: number;
  leftPct: number;
  widthPct: number;
  isCritical: boolean;
}) {
  const duration = daysBetween(t.start, t.end);
  const barClass = isCritical ? 'bg-red-500/90' : 'bg-sky-500/80';
  const barProgressClass = isCritical ? 'bg-red-600/70' : 'bg-sky-600/60';
  return (
    <div className="flex border-b border-slate-100 py-1 text-sm hover:bg-slate-50">
      <div className="w-10 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-500 tabular-nums text-xs">
        {rowNum}
      </div>
      <div className="w-24 flex-shrink-0 border-r border-slate-100 px-2 py-1 font-medium text-slate-800" title={t.task_code} style={{ paddingLeft: 8 + level * INDENT_PX }}>
        {t.task_code || '—'}
      </div>
      <div className="min-w-[280px] w-80 flex-shrink-0 border-r border-slate-100 px-2 py-1" style={{ paddingLeft: 8 + level * INDENT_PX }}>
        <div className={`truncate ${isCritical ? 'text-red-700 font-semibold' : 'text-slate-700'}`} title={t.task_name}>{t.task_name || '—'}</div>
      </div>
      <div className="w-24 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-600 tabular-nums">
        {formatDate(t.start)}
      </div>
      <div className="w-24 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-600 tabular-nums">
        {formatDate(t.end)}
      </div>
      <div className="w-16 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-600 tabular-nums" title={`${duration} дн.`}>
        {duration} д.
      </div>
      <div className="min-w-[140px] w-40 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-600 text-xs" style={{ paddingLeft: 8 + level * INDENT_PX }}>
        <div className="truncate" title={t.resources ?? ''}>{t.resources || '—'}</div>
      </div>
      <div className="w-14 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-600 tabular-nums text-xs">
        {t.progress}%
      </div>
      <div className="relative w-full max-w-[520px] flex-shrink-0 py-1 pr-4" style={{ minHeight: 28 }}>
        <div
          className={`absolute top-1 h-5 rounded ${barClass}`}
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            minWidth: 4,
          }}
          title={`${t.start} — ${t.end} · ${t.progress}%${isCritical ? ' · Критический путь' : ''}`}
        >
          {t.progress > 0 && (
            <div
              className={`h-full rounded ${barProgressClass}`}
              style={{ width: `${t.progress}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function GanttWbsRow({
  wbs,
  level,
  rowNum,
  hasChildren,
  expanded,
  onToggle,
  spanStart,
  spanEnd,
  leftPct,
  widthPct,
}: {
  wbs: XerWbsNode;
  level: number;
  rowNum: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggle: () => void;
  spanStart: string;
  spanEnd: string;
  leftPct: number;
  widthPct: number;
}) {
  return (
    <div className="flex border-b border-slate-200 bg-slate-50/80 py-1 text-sm font-medium hover:bg-slate-100">
      <div className="w-10 flex-shrink-0 border-r border-slate-100 py-1 text-slate-500 tabular-nums text-xs">
        {rowNum}
      </div>
      <div className="w-24 flex-shrink-0 border-r border-slate-100 py-1" style={{ paddingLeft: 8 + level * INDENT_PX }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-700"
            aria-label={expanded ? 'Свернуть' : 'Развернуть'}
            title={expanded ? 'Свернуть' : 'Развернуть'}
          >
            {expanded ? '−' : '+'}
          </button>
        ) : (
          <span className="inline-block h-5 w-5" />
        )}
      </div>
      <div className="min-w-[280px] w-80 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-800" style={{ paddingLeft: level * INDENT_PX }}>
        <div className="truncate" title={wbs.wbs_name}>{wbs.wbs_name || '—'}</div>
      </div>
      <div className="w-24 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-500 tabular-nums text-xs">
        {spanStart ? formatDate(spanStart) : '—'}
      </div>
      <div className="w-24 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-500 tabular-nums text-xs">
        {spanEnd ? formatDate(spanEnd) : '—'}
      </div>
      <div className="w-16 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-500 tabular-nums text-xs">
        {spanStart && spanEnd ? `${daysBetween(spanStart, spanEnd)} д.` : '—'}
      </div>
      <div className="min-w-[140px] w-40 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-500 text-xs">
        —
      </div>
      <div className="w-14 flex-shrink-0 border-r border-slate-100 px-2 py-1 text-slate-500 text-xs">
        —
      </div>
      <div className="relative w-full max-w-[520px] flex-shrink-0 py-1 pr-4" style={{ minHeight: 28 }}>
        {spanStart && spanEnd && (
          <div
            className="absolute top-1 h-5 rounded bg-slate-400/50"
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              minWidth: 4,
            }}
          />
        )}
      </div>
    </div>
  );
}

function GanttChart({ schedule }: { schedule: XerSchedule }) {
  const { tasks } = schedule;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const sorted = useMemo(() => [...tasks].sort((a, b) => a.start.localeCompare(b.start)), [tasks]);
  const minDate = useMemo(() => sorted[0]?.start ?? '', [sorted]);
  const maxDate = useMemo(() => {
    let m = '';
    for (const t of sorted) if (t.end > m) m = t.end;
    return m;
  }, [sorted]);

  const totalDays = useMemo(() => {
    if (!minDate || !maxDate) return 1;
    const a = new Date(minDate).getTime();
    const b = new Date(maxDate).getTime();
    return Math.max(1, (b - a) / (24 * 60 * 60 * 1000));
  }, [minDate, maxDate]);

  const leftPct = useCallback((dateStr: string) => {
    const d = new Date(dateStr).getTime();
    const min = new Date(minDate).getTime();
    return ((d - min) / (24 * 60 * 60 * 1000) / totalDays) * 100;
  }, [minDate, totalDays]);

  const widthPct = useCallback((start: string, end: string) => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return Math.max(0.5, ((e - s) / (24 * 60 * 60 * 1000) / totalDays) * 100);
  }, [totalDays]);

  const visibleRows = useMemo(() => buildVisibleRows(schedule, expandedIds), [schedule, expandedIds]);

  const toggleWbs = useCallback((wbsId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(wbsId)) next.delete(wbsId);
      else next.add(wbsId);
      return next;
    });
  }, []);

  const timelineLabels = useMemo(() => {
    const count = Math.min(MAX_TIMELINE_LABELS, Math.max(2, Math.ceil(totalDays / 14)));
    const stepDays = totalDays / (count - 1);
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(minDate);
      d.setDate(d.getDate() + Math.round(i * stepDays));
      return d;
    });
  }, [minDate, totalDays]);

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-8 text-center text-sm text-slate-600">
        Нет работ для отображения в текущем наборе данных (например, пустой выбранный период).
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
      <div className="min-w-[1280px]">
        <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
          <div className="w-10 flex-shrink-0 border-r border-slate-200 px-2 py-2">№</div>
          <div className="w-24 flex-shrink-0 border-r border-slate-200 px-3 py-2">Код</div>
          <div className="min-w-[280px] w-80 flex-shrink-0 border-r border-slate-200 px-3 py-2">Название</div>
          <div className="w-24 flex-shrink-0 border-r border-slate-200 px-3 py-2">Начало</div>
          <div className="w-24 flex-shrink-0 border-r border-slate-200 px-3 py-2">Окончание</div>
          <div className="w-16 flex-shrink-0 border-r border-slate-200 px-3 py-2" title="Длительность (дней)">Длит.</div>
          <div className="min-w-[140px] w-40 flex-shrink-0 border-r border-slate-200 px-2 py-2">Ресурсы</div>
          <div className="w-14 flex-shrink-0 border-r border-slate-200 px-2 py-2" title="Процент завершения">% зав.</div>
          <div className="w-full max-w-[520px] flex-shrink-0 py-2 pr-4">
            <div className="relative h-6">
              {timelineLabels.map((d, i) => {
                const x = leftPct(d.toISOString().slice(0, 10));
                return (
                  <span
                    key={i}
                    className="absolute -translate-x-1/2 whitespace-nowrap text-slate-400"
                    style={{ left: `${x}%` }}
                  >
                    {d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        {visibleRows.map((row, idx) =>
          row.type === 'wbs' ? (
            <GanttWbsRow
              key={`wbs-${row.wbs.id}`}
              wbs={row.wbs}
              level={row.level}
              rowNum={idx + 1}
              hasChildren={row.hasChildren}
              expanded={expandedIds.has(row.wbs.id)}
              onToggle={() => toggleWbs(row.wbs.id)}
              spanStart={row.spanStart ?? ''}
              spanEnd={row.spanEnd ?? ''}
              leftPct={row.spanStart && row.spanEnd ? leftPct(row.spanStart) : 0}
              widthPct={row.spanStart && row.spanEnd ? widthPct(row.spanStart, row.spanEnd) : 0}
            />
          ) : (
            <GanttTaskRow
              key={`task-${row.task.id}`}
              t={row.task}
              level={row.level}
              rowNum={idx + 1}
              leftPct={leftPct(row.task.start)}
              widthPct={widthPct(row.task.start, row.task.end)}
              isCritical={row.task.isCritical ?? false}
            />
          )
        )}
      </div>
      {visibleRows.length >= DISPLAY_LIMIT && (
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
          Показано не более {DISPLAY_LIMIT} строк. Раскройте нужные разделы WBS.
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [schedule, setSchedule] = useState<XerSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [aiDebug, setAiDebug] = useState<{
    status?: number;
    bodyPreview?: string;
    error?: string;
    source?: string;
    n8nNote?: string;
  } | null>(null);

  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('all');
  const [periodAnchor, setPeriodAnchor] = useState<string>(() => todayYmd());

  const displaySchedule = useMemo(() => {
    if (!schedule) return null;
    const anchor = new Date(periodAnchor + 'T12:00:00');
    const a = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
    const filtered = filterTasksByPeriod(schedule.tasks, periodPreset, a);
    return { ...schedule, tasks: filtered };
  }, [schedule, periodPreset, periodAnchor]);

  const periodRangeLabel = useMemo(() => {
    if (!schedule || periodPreset === 'all') return null;
    const anchor = new Date(periodAnchor + 'T12:00:00');
    const a = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
    const b = getPeriodBounds(periodPreset, a);
    if (!b) return null;
    return `${formatDate(b.start)} — ${formatDate(b.end)}`;
  }, [schedule, periodPreset, periodAnchor]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSchedule(null);
    setFileName(file.name);
    setAiError(null);
    setAiAnalysis(null);
    setLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const buffer = reader.result as ArrayBuffer;
        const bytes = new Uint8Array(buffer);
        let text: string;
        try {
          text = new TextDecoder('windows-1251').decode(bytes);
        } catch {
          text = new TextDecoder('utf-8').decode(bytes);
        }
        const parsed = parseXer(text);
        setSchedule(parsed);
        if (parsed.tasks.length === 0) setError('В файле не найдено ни одной работы (TASK).');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка разбора XER');
      } finally {
        setLoading(false);
      }
    };
    reader.onerror = () => {
      setError('Не удалось прочитать файл');
      setLoading(false);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onAnalyzeWithAi = useCallback(async () => {
    if (!displaySchedule || displaySchedule.tasks.length === 0) {
      setAiError(
        !schedule
          ? 'Сначала загрузите файл XER.'
          : 'В выбранном периоде нет работ для анализа (смените период или выберите «Весь график»).'
      );
      setAiDebug(null);
      return;
    }
    setAiLoading(true);
    setAiError(null);
    setAiAnalysis(null);
    setAiDebug(null);
    try {
      // Ограничиваем размер входных данных для стабильной доставки на Production.
      const tasksToSend = displaySchedule.tasks.slice(0, 80);
      const payload = { tasks: tasksToSend };
      // Всегда зовем наш API, чтобы запрос делался на сервере (без CORS) и гарантированно попал в n8n.
      const response = await fetch('/api/analyze-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      const bodyPreview = text.length > 600 ? text.slice(0, 600) + '…' : text;

      let data: { analysis?: string; error?: string; source?: string; n8nNote?: string };
      try {
        data = text
          ? (JSON.parse(text) as { analysis?: string; error?: string; source?: string; n8nNote?: string })
          : {};
      } catch {
        setAiError(response.ok ? 'Неверный ответ сервера.' : `Ошибка сервера (${response.status}). Попробуйте позже.`);
        setAiDebug({ status: response.status, bodyPreview, error: 'JSON parse failed' });
        return;
      }
      if (!response.ok) {
        const msg = data.error || `Ошибка анализа (${response.status}). Проверьте DEEPSEEK_API_KEY в настройках Vercel.`;
        setAiError(msg);
        setAiDebug({
          status: response.status,
          bodyPreview,
          error: msg,
          source: data.source,
          n8nNote: data.n8nNote,
        });
        return;
      }
      setAiDebug({
        status: response.status,
        bodyPreview,
        source: data.source,
        n8nNote: data.n8nNote,
      });
      setAiAnalysis(data.analysis || 'Пустой ответ от ИИ.');
    } catch (err) {
      const msg =
        err instanceof Error && err.message === 'Failed to fetch'
          ? 'Сеть недоступна или таймаут. Проверьте интернет и повторите.'
          : err instanceof Error
            ? err.message
            : 'Ошибка при анализе графика.';
      setAiError(msg);
      setAiDebug({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    } finally {
      setAiLoading(false);
    }
  }, [displaySchedule]);

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold text-slate-900">График из XER (Primavera P6)</h1>
          <p className="mt-1 text-sm text-slate-600">
            plan.alenos.ru · Загрузите файл .xer — отобразится календарный план (работы и сроки).
          </p>
        </header>

        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3">
            <button
              type="button"
              onClick={onAnalyzeWithAi}
              disabled={aiLoading || !schedule}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              title={!schedule ? 'Сначала загрузите XER' : 'Запустить AI-анализ графика'}
            >
              {aiLoading
                ? 'Анализ графика с помощью ИИ DeepSeek...'
                : 'Анализ графика с помощью ИИ DeepSeek'}
            </button>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Файл .xer</span>
            <input
              type="file"
              accept=".xer"
              className="mt-2 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-sky-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white file:hover:bg-sky-700"
              onChange={onFileChange}
              disabled={loading}
            />
          </label>
          {fileName && !loading && <p className="mt-2 text-xs text-slate-500">Выбран: {fileName}</p>}
          {loading && <p className="mt-2 text-sm text-slate-500">Загрузка и разбор…</p>}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          {aiError && <p className="mt-2 text-sm text-red-600">{aiError}</p>}
          {aiDebug && (
            <details className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
              <summary className="cursor-pointer font-medium text-slate-600">Технические детали последнего запроса</summary>
              <div className="mt-2 space-y-1 font-mono text-slate-600">
                {aiDebug.status != null && <p>HTTP статус: {aiDebug.status}</p>}
                {aiDebug.source && <p>Источник ответа: {aiDebug.source}</p>}
                {aiDebug.n8nNote && (
                  <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900 whitespace-pre-wrap">
                    {aiDebug.n8nNote}
                  </p>
                )}
                {aiDebug.error && <p className="text-red-600">Ошибка: {aiDebug.error}</p>}
                {aiDebug.bodyPreview && (
                  <p className="break-all">Ответ (начало): {aiDebug.bodyPreview}</p>
                )}
                <p className="text-slate-500">
                  Проверка n8n: откройте на <strong>этом же домене</strong>{' '}
                  <span className="text-sky-700">/api/analyze-schedule</span> — нужны{' '}
                  <code>vercelEnv</code> (production на основном сайте) и{' '}
                  <code>n8nWebhookConfigured: true</code>. Если работает только на *.vercel.app — в Vercel
                  включите переменные для среды <strong>Production</strong>, не только Preview.
                </p>
              </div>
            </details>
          )}
          {aiAnalysis && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="mb-2 text-sm font-medium text-emerald-800">
                Предложения по улучшению графика (DeepSeek)
              </p>
              <pre className="whitespace-pre-wrap text-sm text-slate-700">{aiAnalysis}</pre>
            </div>
          )}
        </section>

        {schedule && displaySchedule && (
          <section>
            <div className="mb-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="mb-2 text-sm font-medium text-slate-800">Период отображения</p>
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span>Интервал</span>
                  <select
                    value={periodPreset}
                    onChange={(e) => setPeriodPreset(e.target.value as PeriodPreset)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
                  >
                    <option value="all">Весь график</option>
                    <option value="week">Неделя (пн–вс)</option>
                    <option value="month">Месяц</option>
                    <option value="year">Год</option>
                  </select>
                </label>
                {periodPreset !== 'all' && (
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    <span>Опорная дата</span>
                    <input
                      type="date"
                      value={periodAnchor}
                      onChange={(e) => setPeriodAnchor(e.target.value)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
                    />
                  </label>
                )}
              </div>
              {periodRangeLabel && (
                <p className="mt-2 text-xs text-slate-500">
                  Показаны работы, пересекающие период: <strong>{periodRangeLabel}</strong>
                </p>
              )}
              {periodPreset !== 'all' && displaySchedule.tasks.length === 0 && (
                <p className="mt-2 text-sm text-amber-700">
                  В этом периоде нет работ по датам начала/окончания. Смените дату или интервал.
                </p>
              )}
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-4 text-sm text-slate-600">
              <span>
                {periodPreset === 'all' ? (
                  <>
                    Работ: <strong>{displaySchedule.tasks.length}</strong>
                  </>
                ) : (
                  <>
                    В периоде: <strong>{displaySchedule.tasks.length}</strong>
                    <span className="text-slate-500"> (всего в файле: {schedule.tasks.length})</span>
                  </>
                )}
              </span>
              <span>Связей: {schedule.links.length}</span>
              <button
                type="button"
                onClick={() => downloadCsv(displaySchedule.tasks)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              >
                Скачать для Excel (CSV)
              </button>
            </div>
            <GanttChart
              key={`${periodPreset}-${periodAnchor}`}
              schedule={displaySchedule}
            />
          </section>
        )}
      </main>
    </div>
  );
}
