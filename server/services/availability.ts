import { db } from '../db.ts';

export interface TimeSlot {
  startIso: string;
  endIso: string;
  label: string;
  available: boolean;
}

function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Compute bookable appointment slots for an expert on a target YYYY-MM-DD date,
 * subtracting break periods and already confirmed/rescheduled appointments.
 */
export function getAvailableSlotsForDate(expertId: string, dateStr: string, durationMinutes = 45): TimeSlot[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return [];

  const targetDate = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(targetDate.getTime())) return [];

  const dayOfWeek = targetDate.getUTCDay();

  const schedules = db
    .prepare('SELECT start_time, end_time, is_break FROM expert_availability WHERE expert_id = ? AND day_of_week = ? ORDER BY start_time ASC')
    .all(expertId, dayOfWeek) as Array<{ start_time: string; end_time: string; is_break: number }>;

  if (schedules.length === 0) return [];

  const workingWindows = schedules.filter((s) => s.is_break === 0);
  const breakWindows = schedules.filter((s) => s.is_break === 1);

  const dayStartIso = `${dateStr}T00:00:00.000Z`;
  const dayEndIso = `${dateStr}T23:59:59.999Z`;

  const existingBookings = db
    .prepare(`
      SELECT scheduled_start, scheduled_end
      FROM appointments
      WHERE expert_id = ? AND status IN ('confirmed', 'rescheduled')
        AND scheduled_start >= ? AND scheduled_start <= ?
    `)
    .all(expertId, dayStartIso, dayEndIso) as Array<{ scheduled_start: string; scheduled_end: string }>;

  const slots: TimeSlot[] = [];
  const nowMs = Date.now();

  for (const win of workingWindows) {
    const startMin = parseMinutes(win.start_time);
    const endMin = parseMinutes(win.end_time);

    for (let cursor = startMin; cursor + durationMinutes <= endMin; cursor += durationMinutes) {
      const slotEnd = cursor + durationMinutes;

      // Check break overlap
      const hitsBreak = breakWindows.some((b) => {
        const bStart = parseMinutes(b.start_time);
        const bEnd = parseMinutes(b.end_time);
        return cursor < bEnd && slotEnd > bStart;
      });
      if (hitsBreak) continue;

      const hh = String(Math.floor(cursor / 60)).padStart(2, '0');
      const mm = String(cursor % 60).padStart(2, '0');
      const startDate = new Date(`${dateStr}T${hh}:${mm}:00.000Z`);
      const endDate = new Date(startDate.getTime() + durationMinutes * 60000);

      if (startDate.getTime() <= nowMs + 15 * 60000) continue;

      const overlapsBooking = existingBookings.some((bk) => {
        const bStart = new Date(bk.scheduled_start).getTime();
        const bEnd = new Date(bk.scheduled_end).getTime();
        return startDate.getTime() < bEnd && endDate.getTime() > bStart;
      });

      slots.push({
        startIso: startDate.toISOString(),
        endIso: endDate.toISOString(),
        label: `${hh}:${mm} UTC`,
        available: !overlapsBooking,
      });
    }
  }

  return slots;
}

export function hasAppointmentConflict(
  expertId: string,
  startIso: string,
  endIso: string,
  excludeAppointmentId?: string
): boolean {
  const query = excludeAppointmentId
    ? `SELECT COUNT(*) as cnt FROM appointments WHERE expert_id = ? AND id != ? AND status IN ('confirmed', 'rescheduled') AND scheduled_start < ? AND scheduled_end > ?`
    : `SELECT COUNT(*) as cnt FROM appointments WHERE expert_id = ? AND status IN ('confirmed', 'rescheduled') AND scheduled_start < ? AND scheduled_end > ?`;

  const row = excludeAppointmentId
    ? (db.prepare(query).get(expertId, excludeAppointmentId, endIso, startIso) as { cnt: number })
    : (db.prepare(query).get(expertId, endIso, startIso) as { cnt: number });

  return row.cnt > 0;
}
