import React, { useEffect, useRef } from "react";
import { Animated, View, Text, TouchableOpacity, StyleSheet, Dimensions, Platform } from "react-native";

const W = Dimensions.get("window").width;

export default function Island({ item, speaking, onDismiss, onSnooze }) {
  const open = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const last = useRef(item);
  if (item) last.current = item;

  useEffect(() => {
    Animated.spring(open, { toValue: item ? 1 : 0, friction: 7, tension: 70, useNativeDriver: false }).start();
  }, [item]);

  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1.5, duration: 550, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 550, useNativeDriver: true })
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  const r = (out) => open.interpolate({ inputRange: [0, 1], outputRange: out });
  const it = last.current;

  return (
    <Animated.View
      pointerEvents={item ? "auto" : "none"}
      style={[s.island, {
        width: r([112, W - 24]), height: r([34, 168]), borderRadius: r([17, 32]),
        opacity: open.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 1, 1] })
      }]}
    >
      <View style={s.top}>
        <Animated.View style={[s.dot, { transform: [{ scale: pulse }] }]} />
        <Text style={s.label} numberOfLines={1}>
          {it?.kind === "alarm" ? "Alarm" : "Reminder"}{speaking ? "  ·  speaking" : ""}
        </Text>
      </View>
      <Animated.View style={{ opacity: open.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] }) }}>
        <Text style={s.title} numberOfLines={2}>{it?.title}</Text>
        <View style={s.btns}>
          <TouchableOpacity style={[s.btn, s.ghost]} onPress={onSnooze}><Text style={s.ghostT}>Snooze 5 min</Text></TouchableOpacity>
          <TouchableOpacity style={[s.btn, s.solid]} onPress={onDismiss}><Text style={s.solidT}>Dismiss</Text></TouchableOpacity>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  island: {
    position: "absolute", top: Platform.OS === "ios" ? 50 : 30, alignSelf: "center",
    backgroundColor: "#000", paddingHorizontal: 16, paddingVertical: 8, overflow: "hidden", zIndex: 100, elevation: 20
  },
  top: { flexDirection: "row", alignItems: "center", height: 18 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#34D399", marginRight: 8 },
  label: { color: "#9CA3AF", fontSize: 12, fontWeight: "600" },
  title: { color: "#fff", fontSize: 22, fontWeight: "bold", marginTop: 14 },
  btns: { flexDirection: "row", marginTop: 18 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 20, alignItems: "center" },
  ghost: { backgroundColor: "#1F2937", marginRight: 10 },
  solid: { backgroundColor: "#fff" },
  ghostT: { color: "#fff", fontWeight: "600" },
  solidT: { color: "#000", fontWeight: "700" }
});
