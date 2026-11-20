import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, Platform, SafeAreaView, KeyboardAvoidingView, Switch
} from "react-native";
import * as Notifications from "expo-notifications";
import * as Speech from "expo-speech";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { Ionicons } from "@expo/vector-icons";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { parseReminder, planReminder } from "./parser";
import { buildSpeech } from "./speech";
import { store, getSettings, saveSettings, DEFAULT_SETTINGS } from "./store";
import { SOUNDS } from "./sounds";
import Island from "./Island";

const SILENCE_MS = 4500;   // pause after speech before asking "finished?"
const IDLE_MS = 20000;     // give up if nothing is said at all
const CHIPS = ["remind me to take my tablet at 12:30", "school wake up at 10:45", "tomorrow at 7 pm call mom"];
const chan = (sound) => `nexora_${sound}_v1`;
const fmt = (d) => new Date(d).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

Notifications.setNotificationHandler({
  // In the foreground NEXORA shows its own island and plays its own sound.
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false })
});

const Chip = ({ label, on, onPress }) => (
  <TouchableOpacity style={[s.chip, on && s.chipOn]} onPress={onPress}>
    <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
  </TouchableOpacity>
);

export default function App() {
  const [text, setText] = useState("");
  const [events, setEvents] = useState([]);
  const [listening, setListening] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [ringing, setRinging] = useState(null);
  const [speaking, setSpeaking] = useState(false);

  const baseRef = useRef("");      // text already committed
  const lastRef = useRef("");      // in-progress transcript
  const wantRef = useRef(false);   // customer still wants to talk
  const silenceRef = useRef(null);
  const idleRef = useRef(null);
  const playerRef = useRef(null);
  const previewRef = useRef(null);
  const autoRef = useRef(null);
  const fireRef = useRef(null);

  const preview = useMemo(() => (text.trim() ? parseReminder(text) : null), [text]);

  /* ---------- setup ---------- */
  async function refresh() {
    const all = await store.list();
    setEvents(all.filter((e) => !e.done).sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt)));
  }

  useEffect(() => {
    (async () => {
      setSettings(await getSettings());
      try { await setAudioModeAsync({ playsInSilentMode: true }); } catch {}
      if (Platform.OS === "android") {
        for (const [id, v] of Object.entries(SOUNDS)) {
          await Notifications.setNotificationChannelAsync(chan(id), {
            name: `NEXORA - ${v.label}`, importance: Notifications.AndroidImportance.MAX,
            sound: `${id}.wav`, vibrationPattern: [0, 400, 200, 400]
          });
        }
      }
      try {
        const v = await Speech.getAvailableVoicesAsync();
        setVoices(v.filter((x) => x.language?.toLowerCase().startsWith("en")).slice(0, 8));
      } catch {}
      refresh();
    })();
  }, []);

  /* ---------- firing: island + sound + talk-back ---------- */
  const speakOpts = (sets, extra = {}) => ({
    language: "en-IN", voice: sets.voice || undefined, rate: sets.rate, pitch: sets.pitch, ...extra
  });

  function stopRinging() {
    clearTimeout(autoRef.current);
    Speech.stop();
    try { playerRef.current?.pause(); playerRef.current?.remove(); } catch {}
    playerRef.current = null;
    setSpeaking(false);
    setRinging(null);
  }

  async function ring(item, sets) {
    stopRinging();
    setRinging(item);
    try {
      const p = createAudioPlayer((SOUNDS[item.sound] || SOUNDS[sets.sound] || SOUNDS.chime).src);
      p.loop = item.kind === "alarm";   // alarms keep ringing until dismissed
      p.volume = 1;
      p.play();
      playerRef.current = p;
    } catch {}
    if (sets.speak) {
      setSpeaking(true);
      if (playerRef.current) playerRef.current.volume = 0.25;
      const done = () => { setSpeaking(false); if (playerRef.current) playerRef.current.volume = 1; };
      Speech.speak(buildSpeech(item.title, item.kind), speakOpts(sets, { onDone: done, onStopped: done, onError: done }));
    }
    if (item.kind !== "alarm") autoRef.current = setTimeout(stopRinging, 20000);
  }

  fireRef.current = async (id) => {
    if (!id) return;
    const [item, sets] = await Promise.all([store.get(id), getSettings()]); // reminder is fetched from the store/backend
    if (!item) return;
    if (!item.repeat) await store.put({ ...item, done: true });
    refresh();
    ring(item, sets);
  };

  useEffect(() => {
    const a = Notifications.addNotificationReceivedListener((n) => fireRef.current(n.request.content.data?.id));
    const b = Notifications.addNotificationResponseReceivedListener((r) => fireRef.current(r.notification.request.content.data?.id));
    Notifications.getLastNotificationResponseAsync().then((r) => r && fireRef.current(r.notification.request.content.data?.id));
    return () => { a.remove(); b.remove(); };
  }, []);

  const makeContent = (item, sound) => ({
    title: item.kind === "alarm" ? `⏰ ${item.title}` : item.title,
    body: `${item.title} - tap to open NEXORA`,
    sound: `${sound}.wav`, data: { id: item.id }, interruptionLevel: "timeSensitive"
  });

  async function snooze() {
    const item = ringing;
    stopRinging();
    if (!item) return;
    const when = new Date(Date.now() + 5 * 60000);
    const sound = item.sound || settings.sound;
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: makeContent(item, sound),
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: chan(sound) }
    });
    await store.put({ ...item, done: false, fireAt: when.toISOString(), notificationId });
    refresh();
  }

  /* ---------- voice input: keeps listening until the customer is done ---------- */
  function begin() {
    ExpoSpeechRecognitionModule.start({
      lang: "en-IN", interimResults: true, continuous: true,
      androidIntentOptions: {
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 6000,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 6000,
        EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 30000
      }
    });
  }

  function finishListening() {
    clearTimeout(silenceRef.current);
    clearTimeout(idleRef.current);
    wantRef.current = false;
    try { ExpoSpeechRecognitionModule.stop(); } catch {}
    if ((baseRef.current + lastRef.current).trim()) setConfirm(true);
  }

  async function startVoice() {
    if (listening || wantRef.current) return finishListening();
    const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!p.granted) return Alert.alert("Microphone needed", "Allow microphone access to use voice.");
    stopRinging();
    setConfirm(false);
    baseRef.current = text.trim() ? text.trim() + " " : "";
    lastRef.current = "";
    wantRef.current = true;
    idleRef.current = setTimeout(() => { if (!(baseRef.current + lastRef.current).trim()) finishListening(); }, IDLE_MS);
    try { begin(); } catch { wantRef.current = false; Alert.alert("Error", "Voice recognition could not start."); }
  }

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    if (lastRef.current) { baseRef.current += lastRef.current + " "; lastRef.current = ""; }
    if (wantRef.current) setTimeout(() => wantRef.current && begin(), 300);   // recognizer timed out, keep going
    else if (baseRef.current.trim()) setConfirm(true);
  });
  useSpeechRecognitionEvent("result", (e) => {
    const tr = e.results?.[0]?.transcript;
    if (!tr) return;
    if (e.isFinal && Platform.OS === "android") { baseRef.current += tr + " "; lastRef.current = ""; }
    else lastRef.current = tr;
    setText((baseRef.current + lastRef.current).trim());
    clearTimeout(silenceRef.current);
    silenceRef.current = setTimeout(finishListening, SILENCE_MS);   // pause -> ask "finished?"
  });
  useSpeechRecognitionEvent("error", (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    wantRef.current = false;
    setListening(false);
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
      const id = Date.now().toString();
      const sound = settings.sound;
      const item = { id, title: p.title, kind: p.kind, repeat: p.repeat, at: p.at.toISOString(), fireAt: plan.fireAt.toISOString(), sound, done: false };
      const channelId = chan(sound);
      const trigger = p.repeat
        ? { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: p.at.getHours(), minute: p.at.getMinutes(), channelId }
        : { type: Notifications.SchedulableTriggerInputTypes.DATE, date: plan.fireAt, channelId };
      const notificationId = await Notifications.scheduleNotificationAsync({ content: makeContent(item, sound), trigger });
      await store.put({ ...item, notificationId });
      baseRef.current = ""; lastRef.current = "";
      setText(""); setConfirm(false);
      refresh();
      Alert.alert("Reminder set", `${p.title}\n${fmt(plan.fireAt)}${p.repeat ? " (daily)" : ""}\n${plan.note}`);
    } catch { Alert.alert("Error", "Could not create your reminder."); }
  }

  function confirmDelete(item) {
    Alert.alert("Delete reminder?", `"${item.title}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          try { await Notifications.cancelScheduledNotificationAsync(item.notificationId); } catch {}
          await store.remove(item.id);
          refresh();
        }
      }
    ]);
  }

  /* ---------- settings ---------- */
  function update(patch) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    return next;
  }
  function previewSound(id) {
    try {
      previewRef.current?.remove();
      const p = createAudioPlayer(SOUNDS[id].src);
      p.play();
      previewRef.current = p;
      setTimeout(() => { try { p.remove(); } catch {} }, 4500);
    } catch {}
  }
  function hearVoice(sets) {
    Speech.stop();
    Speech.speak(buildSpeech("Take my tablet", "reminder"), speakOpts(sets));
  }

  /* ---------- UI ---------- */
  return (
    <View style={{ flex: 1, backgroundColor: "#0B1020" }}>
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView style={s.container} keyboardShouldPersistTaps="handled">
            <Text style={s.logo}>✦ NEXORA</Text>
            <Text style={s.tagline}>Never forget what matters.</Text>

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
                <TouchableOpacity style={s.test} onPress={() => ring({ id: "test", title: "Take my tablet", kind: "reminder", sound: settings.sound }, settings)}>
                  <Text style={s.cTxt}>Test island, sound and voice</Text>
                </TouchableOpacity>
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

const s = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  logo: { color: "#70B7FF", fontSize: 34, fontWeight: "bold", marginTop: 16 },
  tagline: { color: "#AAB8D0", marginBottom: 25 },
  card: { backgroundColor: "#17243C", padding: 20, borderRadius: 20, marginBottom: 14 },
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
  test: { backgroundColor: "#315F9C", padding: 14, borderRadius: 12, marginTop: 16, alignItems: "center" },
  section: { color: "white", fontSize: 22, fontWeight: "bold", marginTop: 16, marginBottom: 15 },
  eventCard: { backgroundColor: "#17243C", padding: 17, borderRadius: 15, marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eventTitle: { color: "white", fontWeight: "bold", fontSize: 18, flex: 1, marginRight: 10 },
  eventDate: { color: "#B6C4DA", marginTop: 8 },
  empty: { color: "#AAB8D0" },
  footer: { color: "#70819D", textAlign: "center", marginVertical: 35 }
});
