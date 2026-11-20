const MED = /\b(pills?|tablets?|medicines?|medication|capsules?|insulin|vitamins?)\b/i;

export function buildSpeech(title, kind = "reminder") {
  const t = (title || "your reminder").trim();
  const med = t.match(MED);
  if (med) return `Hey, you just need to take your ${med[1].toLowerCase()}. Don't skip it!`;
  if (/\bwake\b/i.test(t)) return `Good morning! It's time to wake up${/school/i.test(t) ? " for school" : ""}.`;
  if (/\b(school|class|exam|meeting|tournament|match)\b/i.test(t)) return `Heads up! ${t} is coming up. Get ready.`;
  return kind === "alarm" ? `Alarm! ${t}.` : `Hey, a quick reminder: ${t}.`;
}
