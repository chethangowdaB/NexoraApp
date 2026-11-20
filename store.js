import AsyncStorage from "@react-native-async-storage/async-storage";

// Set to your backend (GET/POST /reminders, GET/DELETE /reminders/:id). Empty = on-device only.
export const API_URL = "";

const KEY = "nexora_reminders_v3";
const SKEY = "nexora_settings_v1";
export const DEFAULT_SETTINGS = { sound: "chime", voice: null, rate: 1, pitch: 1, speak: true };

const readLocal = async () => {
  try { return JSON.parse((await AsyncStorage.getItem(KEY)) || "[]"); } catch { return []; }
};
const writeLocal = (items) => AsyncStorage.setItem(KEY, JSON.stringify(items));
const api = async (path, opts = {}) => {
  const r = await fetch(API_URL + path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export const store = {
  async list() {
    if (API_URL) { try { const items = await api("/reminders"); await writeLocal(items); return items; } catch {} }
    return readLocal();
  },
  async get(id) {
    if (API_URL) { try { return await api(`/reminders/${id}`); } catch {} }
    return (await readLocal()).find((r) => r.id === id) || null;
  },
  async put(item) {
    const items = await readLocal();
    const i = items.findIndex((r) => r.id === item.id);
    if (i < 0) items.push(item); else items[i] = item;
    await writeLocal(items);
    if (API_URL) { try { await api("/reminders", { method: "POST", body: JSON.stringify(item) }); } catch {} }
  },
  async remove(id) {
    await writeLocal((await readLocal()).filter((r) => r.id !== id));
    if (API_URL) { try { await api(`/reminders/${id}`, { method: "DELETE" }); } catch {} }
  }
};

export async function getSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse((await AsyncStorage.getItem(SKEY)) || "{}") }; }
  catch { return DEFAULT_SETTINGS; }
}
export const saveSettings = (s) => AsyncStorage.setItem(SKEY, JSON.stringify(s));
