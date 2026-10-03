// src/paper/clock.js — Eastern-time helpers
//
// Always the real clock. Tests pass `now` to control time.

const TZ = 'America/New_York';

class Clock {
  constructor({ now = null } = {}) {
    this._fixedNow = now; // tests only: function returning ms
  }

  get simulated() { return !!this._fixedNow; }

  now() { return this._fixedNow ? this._fixedNow() : Date.now(); }

  date() { return new Date(this.now()); }
  iso() { return this.date().toISOString(); }

  // { date: 'YYYY-MM-DD', hm: 'HH:MM', minutes, weekday (0=Sun) } in New York time
  et(ms = this.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    const hm = `${parts.hour}:${parts.minute}`;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hm,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    };
  }

  today() { return this.et().date; }

  isMarketHours(ms = this.now()) {
    const e = this.et(ms);
    return e.weekday >= 1 && e.weekday <= 5 && e.minutes >= 570 && e.minutes < 960;
  }

  // ms timestamp of HH:MM ET on the given ET date (handles DST by probing offsets)
  atET(dateStr, hm) {
    const [h, m] = hm.split(':').map(Number);
    for (const off of [-4, -5]) {
      const sign = off < 0 ? '-' : '+';
      const ms = Date.parse(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${sign}0${Math.abs(off)}:00`);
      const e = this.et(ms);
      if (e.date === dateStr && e.hm === `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`) return ms;
    }
    return Date.parse(`${dateStr}T${hm}:00-05:00`);
  }
}

function hmToMinutes(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

module.exports = { Clock, hmToMinutes, TZ };
