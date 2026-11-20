const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const DAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const MON = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const MER = "(a\\.?m\\.?|p\\.?m\\.?)";
const monthIndex = (w) => MONTHS.findIndex((x) => x.startsWith(w.slice(0, 3).toLowerCase()));
const mk = (d, h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);

function hourOptions(t, dated, morningy) {
  const { h, mer } = t;
  if (mer) return [(h % 12) + (/^p/i.test(mer) ? 12 : 0)];
  if (h === 0 || h > 12) return [h];
  const am = h % 12, pm = (h % 12) + 12;
  if (morningy) return [am];
  if (dated) return h === 12 || h <= 6 ? [pm] : [am];
  return h === 12 || h <= 6 ? [pm, am] : [am, pm];
}

export function parseReminder(input, now = new Date()) {
  const raw = (input || "").trim();
  if (!raw) return { ok: false, error: "Tell NEXORA what to remind you about." };

  let s = " " + raw + " ";
  let m;
  const find = (re) => {
    m = s.match(re);
    if (m) s = s.replace(m[0], " ");
    return m;
  };

  const repeat = find(/\b(every\s*day|daily)\b/i) ? "daily" : null;

  let rel = null;
  if (find(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i)) {
    rel = new Date(now.getTime() + Number(m[1]) * (/^h/i.test(m[2]) ? 3600000 : 60000));
    rel.setSeconds(0, 0);
  }

  let date = null, rule = null;
  if (!rel) {
    if (find(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})\\b`, "i")))
      date = { d: +m[1], mo: monthIndex(m[2]) };
    else if (find(new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i")))
      date = { d: +m[2], mo: monthIndex(m[1]) };
    else if (find(/\btomorrow\b/i)) rule = { add: 1 };
    else if (find(/\btoday\b/i)) rule = { add: 0 };
    else if (find(/\b(?:next\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i))
      rule = { wd: DAYS.indexOf(m[1].toLowerCase()) };
  }

  let time = null;
  if (!rel) {
    if (find(new RegExp(`\\b(?:at\\s+)?(\\d{1,2}):(\\d{2})\\s*${MER}?(?![\\w])`, "i")))
      time = { h: +m[1], min: +m[2], mer: m[3] };
    else if (find(new RegExp(`\\b(?:at\\s+)?(\\d{1,2})\\s*${MER}(?![\\w])`, "i")))
      time = { h: +m[1], min: 0, mer: m[2] };
    else if (find(/\bat\s+(\d{1,2})\b/i)) time = { h: +m[1], min: 0, mer: null };
  }

  if (time && (time.min > 59 || (time.mer ? time.h < 1 || time.h > 12 : time.h > 23)))
    return { ok: false, error: "That time doesn't look valid." };
  if (!rel && !date && !rule && !time)
    return { ok: false, error: 'Add a date or time, like "tomorrow at 7 pm" or "on 20th November".' };
  if (repeat && !time && !rel)
    return { ok: false, error: 'Add a time for repeating reminders, like "every day at 6:30 am".' };

  const alarmy = /\b(wake\s?-?up|wake|alarm)\b/i.test(raw);
  const morningy = /\b(wake|school|morning|breakfast|gym)\b/i.test(raw);
  const dated = !!(date || rule);
  const opts = time ? hourOptions(time, dated, morningy) : [9];
  const min = time ? time.min : 0;
  const startToday = mk(now, 0, 0);
  let at = null;

  if (rel) {
    at = rel;
  } else if (date) {
    for (let y = now.getFullYear(); y <= now.getFullYear() + 8 && !at; y++) {
      const c = new Date(y, date.mo, date.d);
      if (c.getMonth() !== date.mo || c.getDate() !== date.d) continue;
      const cand = mk(c, opts[0], min);
      if (time ? cand > now : c >= startToday) at = cand;
    }
    if (!at) return { ok: false, error: "That date doesn't exist. Check the day and month." };
  } else if (rule && rule.wd !== undefined) {
    const base = new Date(startToday);
    base.setDate(base.getDate() + ((rule.wd - now.getDay() + 7) % 7));
    at = mk(base, opts[0], min);
    if (at <= now) at.setDate(at.getDate() + 7);
  } else if (rule) {
    const base = new Date(startToday);
    base.setDate(base.getDate() + rule.add);
    at = mk(base, opts[0], min);
    if (time && at <= now) return { ok: false, error: "That time has already passed today." };
  } else {
    for (let add = 0; add <= 1 && !at; add++) {
      const base = new Date(startToday);
      base.setDate(base.getDate() + add);
      for (const h of opts) {
        const c = mk(base, h, min);
        if (c > now) { at = c; break; }
      }
    }
  }

  let title = s.replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim();
  title = title.replace(/^(?:please\s+)?(?:remind me(?: to| about| of)?|(?:set|create|add|make)\s+(?:me\s+)?(?:an?\s+)?|i have got|i have|i've got|i need to|i want to|i got)\b\s*/i, "");
  let prev;
  do { prev = title; title = title.replace(/^(?:on|at|for|to|a|an|the|and|my|reminder|alarm)\s+/i, ""); } while (title !== prev);
  do { prev = title; title = title.replace(/\s+(?:on|at|for|to|by|and|reminder|alarm)$/i, ""); } while (title !== prev);
  title = title ? title[0].toUpperCase() + title.slice(1) : "Reminder";

  const hasTime = !!time || !!rel;
  return { ok: true, title, at, hasTime, repeat, kind: alarmy && hasTime ? "alarm" : "reminder" };
}

export function planReminder(p, now = new Date()) {
  if (p.hasTime || p.repeat) return { fireAt: p.at, note: "at the time you set" };
  const evening = new Date(p.at);
  evening.setDate(evening.getDate() - 1);
  evening.setHours(18, 0, 0, 0);
  if (evening > now) return { fireAt: evening, note: "6 PM the evening before" };
  const morning = new Date(p.at);
  morning.setHours(8, 0, 0, 0);
  if (morning > now) return { fireAt: morning, note: "8 AM on the day" };
  return { fireAt: new Date(now.getTime() + 60000), note: "event is today, so in 1 minute" };
}
