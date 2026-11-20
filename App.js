import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, Platform, SafeAreaView, KeyboardAvoidingView, Switch, Linking
} from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Ionicons } from "@expo/vector-icons";
import { parseReminder, planReminder } from "./parser";
import { buildSpeech } from "./speech";
import { store, getSettings, saveSettings, DEFAULT_SETTINGS } from "./store";
import { SOUNDS } from "./sounds";
import Island from "./Island";

// Native modules are loaded defensively: if one is missing from the build, the app still opens.
const safe = (fn) => { try { return fn(); } catch { return null; } };
const Audio = safe(() => require("expo-audio"));
const Speech = safe(() => require("expo-speech"));
const Launcher = safe(() => require("expo-intent-launcher"));
const SR = safe(() => require("expo-speech-recognition"));
const SRModule = SR?.ExpoSpeechRecognitionModule;
const useSREvent = SR?.useSpeechRecognitionEvent || (() => {});

const SILENCE_MS = 4500;
const IDLE_MS = 20000;
const CHAIN_N = 8;        // an alarm re-rings this many extra times while the app is closed
const CHAIN_MS = 45000;   // ...every 45 seconds, until you open the app or tap it
const PKG = Constants.expoConfig?.android?.package;
const CHIPS = ["remind me to take my tablet at 12:30", "school wake up at 10:45", "tomorrow at 7 pm call mom"];
const chan = (sound) => `nexora_${sound}_v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d) => new Date(d).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const T = Notifications.SchedulableTriggerInputTypes;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
});

const Chip = ({ label, on, onPress }) => (
  <TouchableOpacity style={[s.chip, on && s.chipOn]} onPress={onPress}>
    <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
  </TouchableOpacity>
);

class Boundary extends React.Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <View style={{ flex: 1, backgroundColor: "#0B1020", padding: 24, justifyContent: "center" }}>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "bold" }}>NEXORA hit an error</Text>
          <Text style={{ color: "#FFB4B4", marginTop: 12 }}>{String(this.state.err?.message || this.state.err)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [text, setText] = useState("");
  const [events, setEvents] = useState([]);
  const [listening, setListening] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [ringing, setRinging] = useState(null);
  const [speaking, setSpeaking] = useState(false);

  const baseRef = useRef(""); const lastRef = useRef(""); const wantRef = useRef(false);
  const silenceRef = useRef(null); const idleRef = useRef(null);
  const playerRef = useRef(null); const previewRef = useRef(null);
  const autoRef = useRef(null); const fireRef = useRef(null);
  const genRef = useRef(0); const ringingRef = useRef(null);

  const preview = useMemo(() => (text.trim() ? parseReminder(text) : null), [text]);

  /* ---------- setup ---------- */
  async function refresh() {
    try {
      const all = await store.list();
      setEvents(all.filter((e) => !e.done).sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt)));
    } catch {}
  }

  useEffect(() => {
    (async () => {
      try { setSettings(await getSettings()); } catch {}
      try { await Audio?.setAudioModeAsync({ playsInSilentMode: true }); } catch {}
      if (Platform.OS === "android") {
        for (const [id, v] of Object.entries(SOUNDS)) {
          try {
            await Notifications.setNotificationChannelAsync(chan(id), {
              name: `NEXORA - ${v.label}`, importance: Notifications.AndroidImportance.MAX,
              sound: `${id}.wav`, vibrationPattern: [0, 400, 200, 400], bypassDnd: true
            });
          } catch {}
        }
      }
      try {
        const v = await Speech?.getAvailableVoicesAsync();
        setVoices((v || []).filter((x) => x.language?.toLowerCase().startsWith("en")).slice(0, 8));
      } catch {}
      refresh();
    })();
  }, []);

  /* ---------- ringing: sound, then voice, repeat for alarms ---------- */
  function stopRinging() {
    genRef.current++;
    clearTimeout(autoRef.current);
    try { Speech?.stop(); } catch {}
    try { playerRef.current?.pause(); playerRef.current?.remove(); } catch {}
    playerRef.current = null; ringingRef.current = null;
    setSpeaking(false); setRinging(null);
  }

  function playOnce(src) {
    return new Promise((resolve) => {
      try {
        try { playerRef.current?.remove(); } catch {}
        const p = Audio.createAudioPlayer(src);
        playerRef.current = p;
        const sub = p.addListener("playbackStatusUpdate", (st) => { if (st.didJustFinish) { sub.remove(); resolve(); } });
        p.volume = 1; p.play();
        setTimeout(resolve, 9000);   // safety net
      } catch { resolve(); }
    });
  }

  function speakOnce(line, sets) {
    return new Promise((resolve) => {
      if (!Speech) return resolve();
      setSpeaking(true);
      const done = () => { setSpeaking(false); resolve(); };
      Speech.speak(line, { language: "en-IN", voice: sets.voice || undefined, rate: sets.rate, pitch: sets.pitch, onDone: done, onStopped: done, onError: done });
      setTimeout(done, 15000);
    });
  }

  async function ring(item, sets) {
    stopRinging();
    const gen = ++genRef.current;
    ringingRef.current = item; setRinging(item);
    const src = (SOUNDS[item.sound] || SOUNDS[sets.sound] || SOUNDS.chime).src;
    const loop = item.kind === "alarm";
    do {
      await playOnce(src);                                  // the tone first...
      if (gen !== genRef.current) return;
      if (sets.speak) await speakOnce(buildSpeech(item.title, item.kind), sets);   // ...then the voice (never at the same time)
      if (gen !== genRef.current) return;
      if (loop) await sleep(1200);
    } while (loop && gen === genRef.current);
    if (gen === genRef.current) autoRef.current = setTimeout(stopRinging, 3000);
  }

  /* ---------- scheduling (works offline and with the app closed) ---------- */
  const makeContent = (item, chain) => ({
    title: item.kind === "alarm" ? `⏰ ${item.title}` : item.title,
    body: chain ? `${item.title} - still ringing, tap to stop` : `${item.title} - tap to open NEXORA`,
    sound: `${item.sound}.wav`, data: { id: item.id, chain: !!chain }, interruptionLevel: "timeSensitive"
  });

  async function scheduleItem(item, when) {
    const channelId = chan(item.sound);
    const trigger = item.repeat
      ? { type: T.DAILY, hour: when.getHours(), minute: when.getMinutes(), channelId }
      : { type: T.DATE, date: when, channelId };
    const notificationId = await Notifications.scheduleNotificationAsync({ content: makeContent(item), trigger });
    const chainIds = [];
    if (item.kind === "alarm" && !item.repeat) {
      for (let k = 1; k <= CHAIN_N; k++) {
        chainIds.push(await Notifications.scheduleNotificationAsync({
          content: makeContent(item, true),
          trigger: { type: T.DATE, date: new Date(when.getTime() + k * CHAIN_MS), channelId }
        }));
      }
    }
    return { notificationId, chainIds };
  }

  async function cancelChain(item) {
    for (const id of item.chainIds || []) { try { await Notifications.cancelScheduledNotificationAsync(id); } catch {} }
  }

  fireRef.current = async (id, chain) => {
    if (!id) return;
    const [item, sets] = await Promise.all([store.get(id), getSettings()]);   // fetched from the store/backend
    if (!item) return;
    if (chain && ringingRef.current?.id === id) return;
    await cancelChain(item);                       // app is awake now, stop the background re-rings
    await store.put({ ...item, done: item.repeat ? false : true, chainIds: [] });
    refresh();
    ring(item, sets);
  };

  useEffect(() => {
    const a = Notifications.addNotificationReceivedListener((n) => fireRef.current(n.request.content.data?.id, n.request.content.data?.chain));
    const b = Notifications.addNotificationResponseReceivedListener((r) => fireRef.current(r.notification.request.content.data?.id, false));
    Notifications.getLastNotificationResponseAsync().then((r) => r && fireRef.current(r.notification.request.content.data?.id, false)).catch(() => {});
    return () => { a.remove(); b.remove(); };
  }, []);

  async function snooze() {
    const item = ringing;
    stopRinging();
    if (!item) return;
    const when = new Date(Date.now() + 5 * 60000);
    const next = { ...item, done: false, repeat: null, fireAt: when.toISOString() };
    const ids = await scheduleItem(next, when);
    await store.put({ ...next, ...ids });
    refresh();
  }

  /* ---------- voice input ---------- */
  function begin() {
    SRModule.start({
      lang: "en-IN", interimResults: true, continuous: true,
      androidIntentOptions: {
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 6000,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 6000,
        EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 30000
      }
    });
  }

  function finishListening() {
    clearTimeout(silenceRef.current); clearTimeout(idleRef.current);
    wantRef.current = false;
    try { SRModule?.stop(); } catch {}
    if ((baseRef.current + lastRef.current).trim()) setConfirm(true);
  }

  async function startVoice() {
    if (!SRModule) return Alert.alert("Voice not available", "This build doesn't include speech recognition. Rebuild the app with expo-speech-recognition, or type your reminder.");
    if (listening || wantRef.current) return finishListening();
    const p = await SRModule.requestPermissionsAsync();
    if (!p.granted) return Alert.alert("Microphone needed", "Allow microphone access to use voice.");
    stopRinging(); setConfirm(false);
    baseRef.current = text.trim() ? text.trim() + " " : ""; lastRef.current = "";
    wantRef.current = true;
    idleRef.current = setTimeout(() => { if (!(baseRef.current + lastRef.current).trim()) finishListening(); }, IDLE_MS);
    try { begin(); } catch { wantRef.current = false; Alert.alert("Error", "Voice recognition could not start."); }
  }

  useSREvent("start", () => setListening(true));
  useSREvent("end", () => {
    setListening(false);
    if (lastRef.current) { baseRef.current += lastRef.current + " "; lastRef.current = ""; }
    if (wantRef.current) setTimeout(() => wantRef.current && begin(), 300);
    else if (baseRef.current.trim()) setConfirm(true);
  });
  useSREvent("result", (e) => {
    const tr = e.results?.[0]?.transcript;
    if (!tr) return;
    if (e.isFinal && Platform.OS === "android") { baseRef.current += tr + " "; lastRef.current = ""; } else lastRef.current = tr;
    setText((baseRef.current + lastRef.current).trim());
    clearTimeout(silenceRef.current);
    silenceRef.current = setTimeout(finishListening, SILENCE_MS);
  });
  useSREvent("error", (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    wantRef.current = false; setListening(false);
    Alert.alert("Voice error", e.message || e.error);
  });

  /* ---------- create / delete ---------- */
  async function createReminder() {
    const now = new Date();
    const p = parseReminder(text, now);
    if (!p.ok) return Alert.alert("Couldn't understand that", p.error);
    const plan = planReminder(p, now);

    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return Alert.alert("Notifications off", "Allow notifications in Settings first.");

    try {
      const item = {
        id: Date.now().toString(), title: p.title, kind: p.kind, repeat: p.repeat,
        at: p.at.toISOString(), fireAt: plan.fireAt.toISOString(), sound: settings.sound, done: false
      };
      const ids = await scheduleItem(item, plan.fireAt);
      await store.put({ ...item, ...ids });
      baseRef.current = ""; lastRef.current = "";
      setText(""); setConfirm(false);
      refresh();
      Alert.alert("Reminder set", `${p.title}\n${fmt(plan.fireAt)}${p.repeat ? " (daily)" : ""}\n${plan.note}${ids.chainIds.length ? "\nRings again every 45 seconds if you don't stop it." : ""}`);
    } catch { Alert.alert("Error", "Could not create your reminder."); }
  }

  function confirmDelete(item) {
    Alert.alert("Delete reminder?", `"${item.title}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          try { await Notifications.cancelScheduledNotificationAsync(item.notificationId); } catch {}
          await cancelChain(item);
          await store.remove(item.id);
          refresh();
        }
      }
    ]);
  }

  /* ---------- settings + reliability ---------- */
  function update(patch) {
    const next = { ...settings, ...patch };
    setSettings(next); saveSettings(next);
    return next;
  }
  function previewSound(id) {
    try {
      previewRef.current?.remove();
      const p = Audio.createAudioPlayer(SOUNDS[id].src);
      p.play(); previewRef.current = p;
      setTimeout(() => { try { p.remove(); } catch {} }, 4500);
    } catch {}
  }
  function hearVoice(sets) {
    try { Speech?.stop(); Speech?.speak(buildSpeech("Take my tablet", "reminder"), { language: "en-IN", voice: sets.voice || undefined, rate: sets.rate, pitch: sets.pitch }); } catch {}
  }
  async function openSetting(action, params) {
    try { await Launcher.startActivityAsync(action, params); } catch { Linking.openSettings(); }
  }

  /* ---------- UI ---------- */
  return (
    <View style={{ flex: 1, backgroundColor: "#0B1020" }}>
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView style={s.container} keyboardShouldPersistTaps="handled">
            <Text style={s.logo}>✦ NEXORA</Text>
            <Text style={s.tagline}>Never forget what matters.</Text>

            {Platform.OS === "android" && !settings.reliabilityDone && (
              <View style={s.warn}>
                <Text style={s.warnT}>Allow these so alarms ring when the app is closed</Text>
                <Text style={s.warnS}>Without them Android can delay or mute reminders. Do all three, then tap Done.</Text>
                <TouchableOpacity style={s.warnBtn} onPress={() => openSetting("android.settings.REQUEST_SCHEDULE_EXACT_ALARM", { data: `package:${PKG}` })}><Text style={s.cTxt}>1. Allow exact alarms</Text></TouchableOpacity>
                <TouchableOpacity style={s.warnBtn} onPress={() => openSetting("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS")}><Text style={s.cTxt}>2. Remove battery limits for NEXORA</Text></TouchableOpacity>
                <TouchableOpacity style={s.warnBtn} onPress={() => openSetting("android.settings.APP_NOTIFICATION_SETTINGS", { extra: { "android.provider.extra.APP_PACKAGE": PKG } })}><Text style={s.cTxt}>3. Check notification sound</Text></TouchableOpacity>
                <TouchableOpacity style={[s.warnBtn, { backgroundColor: "#34D399" }]} onPress={() => update({ reliabilityDone: true })}><Text style={s.cTxtDark}>Done</Text></TouchableOpacity>
              </View>
            )}

            <View style={s.card}>
              <Text style={s.heading}>Your personal assistant</Text>
              <TouchableOpacity style={s.voice} onPress={startVoice}>
                <Text style={s.voiceText}>{listening || wantRef.current ? "🎙 Listening... tap when you're done" : "🎙 Speak to NEXORA"}</Text>
              </TouchableOpacity>
              {(listening || wantRef.current) && <Text style={s.hint}>Take your time. I'll ask once you pause.</Text>}

              <TextInput
                style={s.input}
                placeholder="Set a reminder for yourself, e.g. school wake up at 10:45"
                placeholderTextColor="#888"
                value={text}
                onChangeText={setText}
                multiline
              />

              {confirm && (
                <View style={s.confirm}>
                  <Text style={s.confirmQ}>Did you finish?</Text>
                  <View style={{ flexDirection: "row", marginTop: 10 }}>
                    <TouchableOpacity style={[s.cBtn, { backgroundColor: "#34D399" }]} onPress={createReminder}><Text style={s.cTxtDark}>Yes, create it</Text></TouchableOpacity>
                    <TouchableOpacity style={[s.cBtn, { backgroundColor: "#22345A" }]} onPress={startVoice}><Text style={s.cTxt}>Keep talking</Text></TouchableOpacity>
                    <TouchableOpacity style={[s.cBtn, { backgroundColor: "#22345A" }]} onPress={() => { baseRef.current = ""; lastRef.current = ""; setText(""); setConfirm(false); }}><Text style={s.cTxt}>Clear</Text></TouchableOpacity>
                  </View>
                </View>
              )}

              {preview && (
                <Text style={[s.preview, !preview.ok && { color: "#FFB4B4" }]}>
                  {preview.ok ? `${preview.kind === "alarm" ? "⏰" : "✓"} ${preview.title} · ${fmt(preview.at)}${preview.repeat ? " · daily" : ""}` : preview.error}
                </Text>
              )}

              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }}>
                {CHIPS.map((c) => <Chip key={c} label={c} onPress={() => { setText(c); setConfirm(false); }} />)}
              </ScrollView>

              <TouchableOpacity style={s.save} onPress={createReminder}><Text style={s.saveText}>Create my reminder →</Text></TouchableOpacity>
            </View>

            <TouchableOpacity style={s.settingsBtn} onPress={() => setShowSettings(!showSettings)}>
              <Ionicons name="options-outline" size={18} color="#70B7FF" />
              <Text style={s.settingsBtnText}>  Sound and voice</Text>
            </TouchableOpacity>

            {showSettings && (
              <View style={s.card}>
                <Text style={s.label}>Alarm sound (tap to preview)</Text>
                <View style={s.wrap}>
                  {Object.entries(SOUNDS).map(([id, v]) => (
                    <Chip key={id} label={v.label} on={settings.sound === id} onPress={() => { update({ sound: id }); previewSound(id); }} />
                  ))}
                </View>
                <Text style={s.label}>Voice</Text>
                <View style={s.wrap}>
                  <Chip label="Default" on={!settings.voice} onPress={() => hearVoice(update({ voice: null }))} />
                  {voices.map((v) => (
                    <Chip key={v.identifier} label={(v.name || v.identifier).slice(0, 18)} on={settings.voice === v.identifier} onPress={() => hearVoice(update({ voice: v.identifier }))} />
                  ))}
                </View>
                <Text style={s.label}>Speed</Text>
                <View style={s.wrap}>
                  {[["Slow", 0.8], ["Normal", 1], ["Fast", 1.2]].map(([l, v]) => <Chip key={l} label={l} on={settings.rate === v} onPress={() => hearVoice(update({ rate: v }))} />)}
                </View>
                <Text style={s.label}>Pitch</Text>
                <View style={s.wrap}>
                  {[["Low", 0.85], ["Normal", 1], ["High", 1.2]].map(([l, v]) => <Chip key={l} label={l} on={settings.pitch === v} onPress={() => hearVoice(update({ pitch: v }))} />)}
                </View>
                <View style={s.switchRow}>
                  <Text style={s.switchText}>Talk back when a reminder fires</Text>
                  <Switch value={settings.speak} onValueChange={(v) => update({ speak: v })} />
                </View>
                <TouchableOpacity style={s.test} onPress={() => ring({ id: "test", title: "Take my tablet", kind: "alarm", sound: settings.sound }, settings)}>
                  <Text style={s.cTxt}>Test island, sound and voice</Text>
                </TouchableOpacity>
                {Platform.OS === "android" && (
                  <TouchableOpacity style={[s.test, { backgroundColor: "#22345A" }]} onPress={() => update({ reliabilityDone: false })}>
                    <Text style={s.cTxt}>Show alarm reliability checklist</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            <Text style={s.section}>My upcoming reminders</Text>
            {events.map((e) => (
              <View style={s.eventCard} key={e.id}>
                <View style={s.row}>
                  <Text style={s.eventTitle}>{e.kind === "alarm" ? "⏰ " : ""}{e.title}</Text>
                  <TouchableOpacity onPress={() => confirmDelete(e)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel="Delete reminder">
                    <Ionicons name="trash-outline" size={18} color="#FF8585" />
                  </TouchableOpacity>
                </View>
                <Text style={s.eventDate}>{fmt(e.fireAt)}{e.repeat ? " · every day" : ""}{SOUNDS[e.sound] ? ` · ${SOUNDS[e.sound].label}` : ""}</Text>
              </View>
            ))}
            {events.length === 0 && <Text style={s.empty}>No reminders yet. Add your first one!</Text>}
            <Text style={s.footer}>NEXORA • Your time matters.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      <Island item={ringing} speaking={speaking} onDismiss={stopRinging} onSnooze={snooze} />
    </View>
  );
}

export default function Root() {
  return <Boundary><App /></Boundary>;
}

const s = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  logo: { color: "#70B7FF", fontSize: 34, fontWeight: "bold", marginTop: 16 },
  tagline: { color: "#AAB8D0", marginBottom: 25 },
  card: { backgroundColor: "#17243C", padding: 20, borderRadius: 20, marginBottom: 14 },
  warn: { backgroundColor: "#3A2A12", padding: 16, borderRadius: 16, marginBottom: 16 },
  warnT: { color: "#FCD34D", fontWeight: "bold", fontSize: 16 },
  warnS: { color: "#E5D3A8", marginTop: 6, marginBottom: 10 },
  warnBtn: { backgroundColor: "#5B4220", padding: 12, borderRadius: 10, marginTop: 8, alignItems: "center" },
  heading: { color: "white", fontSize: 22, fontWeight: "bold" },
  voice: { backgroundColor: "#315F9C", padding: 17, borderRadius: 12, marginTop: 18, alignItems: "center" },
  voiceText: { color: "white", fontWeight: "bold" },
  hint: { color: "#9FE1CB", marginTop: 8, textAlign: "center" },
  input: { backgroundColor: "#FFF", color: "#111827", padding: 15, borderRadius: 12, marginTop: 16, minHeight: 85 },
  confirm: { backgroundColor: "#0F1B31", padding: 14, borderRadius: 12, marginTop: 12 },
  confirmQ: { color: "white", fontWeight: "bold", fontSize: 16 },
  cBtn: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, marginRight: 8 },
  cTxt: { color: "white", fontWeight: "600" },
  cTxtDark: { color: "#06281E", fontWeight: "700" },
  preview: { color: "#9FE1CB", marginTop: 10 },
  chip: { backgroundColor: "#22345A", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, marginRight: 8, marginBottom: 8 },
  chipOn: { backgroundColor: "#70B7FF" },
  chipText: { color: "#B6C4DA", fontSize: 13 },
  chipTextOn: { color: "#081426", fontWeight: "700" },
  save: { backgroundColor: "#70B7FF", padding: 17, borderRadius: 12, marginTop: 14, alignItems: "center" },
  saveText: { color: "#081426", fontWeight: "bold", fontSize: 16 },
  settingsBtn: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  settingsBtnText: { color: "#70B7FF", fontWeight: "600" },
  label: { color: "#B6C4DA", marginTop: 6, marginBottom: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10 },
  switchText: { color: "white" },
  test: { backgroundColor: "#315F9C", padding: 14, borderRadius: 12, marginTop: 12, alignItems: "center" },
  section: { color: "white", fontSize: 22, fontWeight: "bold", marginTop: 16, marginBottom: 15 },
  eventCard: { backgroundColor: "#17243C", padding: 17, borderRadius: 15, marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eventTitle: { color: "white", fontWeight: "bold", fontSize: 18, flex: 1, marginRight: 10 },
  eventDate: { color: "#B6C4DA", marginTop: 8 },
  empty: { color: "#AAB8D0" },
  footer: { color: "#70819D", textAlign: "center", marginVertical: 35 }
});
