'use client';

import { useCallback, useMemo, useState } from 'react';
import { parseXer, type XerSchedule, type XerTask } from '@/lib/xerParser';

function GanttChart({ tasks, links }: { tasks: XerTask[]; links: XerSchedule['links'] }) {
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

  const leftPct = (dateStr: string) => {
    const d = new Date(dateStr).getTime();
    const min = new Date(minDate).getTime();
    return ((d - min) / (24 * 60 * 60 * 1000) / totalDays) * 100;
  };
  const widthPct = (start: string, end: string) => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return Math.max(0.5, ((e - s) / (24 * 60 * 60 * 1000) / totalDays) * 100);
  };

  const displayTasks = sorted.slice(0, 400);

  return (
    <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
      <div className="min-w-[800px]">
        <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
          <div className="w-48 flex-shrink-0 border-r border-slate-200 px-3 py-2">Код / Название</div>
          <div className="flex-1 py-2 pr-4">
            <div className="relative h-6" style={{ minWidth: `${Math.max(100, totalDays / 7) * 2}px` }}>
              {Array.from({ length: Math.ceil(totalDays / 7) + 1 }).map((_, i) => {
                const d = new Date(minDate);
                d.setDate(d.getDate() + i * 7);
                const x = leftPct(d.toISOString().slice(0, 10));
                return (
                  <span
                    key={i}
                    className="absolute -translate-x-1/2 text-slate-400"
                    style={{ left: `${x}%` }}
                  >
                    {d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        {displayTasks.map((t) => (
          <div
            key={t.id}
            className="flex border-b border-slate-100 py-1 text-sm hover:bg-slate-50"
          >
            <div className="w-48 flex-shrink-0 border-r border-slate-100 px-2 py-1">
              <div className="truncate font-medium text-slate-800" title={t.task_name}>{t.task_code}</div>
              <div className="truncate text-xs text-slate-500" title={t.task_name}>{t.task_name}</div>
            </div>
            <div className="relative flex-1 py-1 pr-4" style={{ minHeight: 28 }}>
              <div
                className="absolute top-1 h-5 rounded bg-sky-500/80"
                style={{
                  left: `${leftPct(t.start)}%`,
                  width: `${widthPct(t.start, t.end)}%`,
                  minWidth: 4,
                }}
                title={`${t.start} — ${t.end} · ${t.progress}%`}
              >
                {t.progress > 0 && (
                  <div
                    className="h-full rounded bg-sky-600/60"
                    style={{ width: `${t.progress}%` }}
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {tasks.length > displayTasks.length && (
        <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
          Показано {displayTasks.length} из {tasks.length} работ. Загрузите файл с фильтром или уменьшите выборку.
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

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSchedule(null);
    setFileName(file.name);
    setLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
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
    reader.readAsText(file, 'utf-8');
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold text-slate-900">График из XER (Primavera P6)</h1>
          <p className="mt-1 text-sm text-slate-600">
            Загрузите файл .xer — отобразится календарный план (работы и сроки).
          </p>
        </header>

        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
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
        </section>

        {schedule && (
          <section>
            <div className="mb-2 flex items-center gap-4 text-sm text-slate-600">
              <span>Работ: {schedule.tasks.length}</span>
              <span>Связей: {schedule.links.length}</span>
            </div>
            <GanttChart tasks={schedule.tasks} links={schedule.links} />
          </section>
        )}
      </main>
    </div>
  );
}
