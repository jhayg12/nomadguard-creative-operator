import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { MotionSpec } from "../schemas.js";

/**
 * Code-rendered motion layer. Everything readable on screen is drawn here (never by the video model),
 * so text is crisp, on-brand and exactly what the spec says. Templates are generic; the words come
 * from the MotionSpec + storyboard, so another brief produces a different ad with the same system.
 */
export type AdProps = {
  brand: string;
  endHeadline: string;
  cta: string;
  spec: MotionSpec;
  /** shot boundaries in seconds, mapped onto the real footage and clipped at the cut */
  scenes: { start: number; end: number }[];
  cut: number; // footage ends / end card starts (s)
  total: number; // seconds
};

const C = {
  navy: "#0B1B3A",
  teal: "#5EEAD4",
  tealDeep: "#14B8A6",
  red: "#FF4D4D",
  white: "#FFFFFF",
  glass: "rgba(14, 22, 40, 0.55)",
};
const FONT = "Montserrat";

const useFonts = () => {
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    const faces = [
      new FontFace(FONT, `url(${staticFile("fonts/Montserrat-500.ttf")})`, { weight: "500" }),
      new FontFace(FONT, `url(${staticFile("fonts/Montserrat-700.ttf")})`, { weight: "700" }),
      new FontFace(FONT, `url(${staticFile("fonts/Montserrat-800.ttf")})`, { weight: "800" }),
    ];
    Promise.all(faces.map((f) => f.load()))
      .then((loaded) => {
        loaded.forEach((f) => document.fonts.add(f));
        continueRender(handle);
      })
      .catch(() => continueRender(handle));
  }, [handle]);
};

const ease = Easing.bezier(0.16, 1, 0.3, 1); // expo-out: fast in, soft settle

/** Fade/slide a block out over the last `n` frames of its sequence. */
const useExit = (durationFrames: number, n = 8) => {
  const f = useCurrentFrame();
  return interpolate(f, [durationFrames - n, durationFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
};

// ---------------------------------------------------------------- background: footage + camera moves
const Footage: React.FC<{ scenes: AdProps["scenes"]; cut: number }> = ({ scenes, cut }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f / fps;
  const i = Math.max(0, scenes.findIndex((s) => t >= s.start && t < s.end));
  const s = scenes[i] ?? scenes[0];
  // slow push-in during each shot + a punch-in that settles right after each cut
  const push = interpolate(t, [s.start, s.end], [1.0, 1.06], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sinceCut = (t - s.start) * fps;
  const punch = i === 0 ? 0 : interpolate(sinceCut, [0, 10], [0.08, 0], { extrapolateRight: "clamp", easing: ease });
  const endPull = t >= cut ? interpolate(t, [cut, cut + 1.2], [1.06, 1.12], { extrapolateRight: "clamp" }) : 1;
  const scale = (t >= cut ? endPull : push + punch);
  // camera shake on the hook stamp impact (frames 6-14)
  const shake = f >= 6 && f <= 14 ? Math.sin(f * 2.7) * interpolate(f, [6, 14], [14, 0]) : 0;
  return (
    <AbsoluteFill style={{ transform: `scale(${scale}) translate(${shake}px, ${shake * 0.6}px)` }}>
      <OffthreadVideo src={staticFile("base.mp4")} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

/** White flash on every cut after the first: a quick, premium "beat" between shots. */
const CutFlashes: React.FC<{ scenes: AdProps["scenes"]; cut: number }> = ({ scenes, cut }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const marks = [...scenes.slice(1).map((s) => s.start), cut];
  const o = Math.max(0, ...marks.map((m) => interpolate(f - m * fps, [0, 1, 7], [0, 0.55, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })));
  return <AbsoluteFill style={{ background: C.white, opacity: o, mixBlendMode: "screen" }} />;
};

const Grade: React.FC = () => (
  <AbsoluteFill
    style={{
      background:
        "linear-gradient(180deg, rgba(5,10,25,0.55) 0%, rgba(5,10,25,0) 28%, rgba(5,10,25,0) 55%, rgba(5,10,25,0.65) 100%)",
    }}
  />
);

// ---------------------------------------------------------------- shot 1: hook
const Hook: React.FC<{ spec: MotionSpec["hook"]; frames: number }> = ({ spec, frames }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit(frames);
  const kick = spec.kicker.split("");
  const stamp = spring({ frame: f - 4, fps, config: { damping: 11, stiffness: 200, mass: 0.7 } });
  const stampScale = interpolate(stamp, [0, 1], [2.6, 1]);
  const head = spec.headline.toUpperCase().split("");
  const headSize = Math.min(170, Math.floor(900 / (head.length * 0.7))); // keep inside the side safe zones
  return (
    <AbsoluteFill style={{ opacity: exit }}>
      {/* kicker: digits drop in one by one, like a departures board */}
      <div style={{ position: "absolute", top: 250, width: "100%", textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: 92, color: C.white, letterSpacing: 6, textShadow: "0 6px 30px rgba(0,0,0,0.6)" }}>
        {kick.map((ch, i) => {
          const p = interpolate(f + 2 - i * 0.8, [0, 5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
          return (
            <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - p) * -60}px)`, opacity: p }}>
              {ch === " " ? " " : ch}
            </span>
          );
        })}
      </div>
      {/* stamp slams in with overshoot */}
      <div style={{ position: "absolute", top: 400, width: "100%", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            transform: `rotate(-7deg) scale(${stampScale})`,
            opacity: interpolate(f, [3, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            border: `8px solid ${C.red}`,
            color: C.red,
            padding: "10px 34px",
            borderRadius: 18,
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 96,
            letterSpacing: 8,
            background: "rgba(20,0,0,0.35)",
            boxShadow: `0 0 60px rgba(255,77,77,${0.35 * stamp})`,
          }}
        >
          {spec.stamp.toUpperCase()}
        </div>
      </div>
      {/* headline: letters rise out of a mask */}
      <div style={{ position: "absolute", top: 1180, width: "100%", textAlign: "center", overflow: "hidden", height: 200 }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: headSize, color: C.white, letterSpacing: -2, lineHeight: "200px", textShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
          {head.map((ch, i) => {
            const p = interpolate(f - 12 - i * 1.4, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
            return (
              <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - p) * 200}px)` }}>
                {ch === " " ? " " : ch}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- shot 2: in-app notification (the product moment)
const Shield: React.FC<{ size: number; draw?: number; fill?: number }> = ({ size, draw = 1, fill = 1 }) => {
  const len = 260;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <path
        d="M50 6 L86 20 V48 C86 70 70 86 50 94 C30 86 14 70 14 48 V20 Z"
        fill={C.teal}
        fillOpacity={0.18 * fill}
        stroke={C.teal}
        strokeWidth={6}
        strokeLinejoin="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - draw)}
      />
      <path d="M34 50 L46 62 L68 38" fill="none" stroke={C.white} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={60} strokeDashoffset={60 * (1 - fill)} />
    </svg>
  );
};

const ProductCard: React.FC<{ brand: string; spec: MotionSpec["product_card"]; frames: number }> = ({ brand, spec, frames }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit(frames);
  const enter = spring({ frame: f - 3, fps, config: { damping: 14, stiffness: 140 } });
  const check = interpolate(f, [18, 32], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const pill = spring({ frame: f - 30, fps, config: { damping: 10, stiffness: 200 } });
  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <div
        style={{
          position: "absolute",
          top: interpolate(enter, [0, 1], [-260, 190]),
          left: 60,
          right: 60,
          padding: "34px 36px",
          borderRadius: 44,
          background: C.glass,
          backdropFilter: "blur(28px) saturate(140%)",
          border: "1.5px solid rgba(255,255,255,0.18)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.45)",
          display: "flex",
          gap: 28,
          alignItems: "center",
          fontFamily: FONT,
          color: C.white,
        }}
      >
        <div style={{ width: 112, height: 112, borderRadius: 28, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Shield size={84} draw={1} fill={check} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, fontWeight: 500, opacity: 0.75 }}>
            <span>{brand.toUpperCase()}</span>
            <span>now</span>
          </div>
          <div style={{ fontSize: 46, fontWeight: 800, marginTop: 6 }}>{spec.title}</div>
          <div style={{ fontSize: 36, fontWeight: 500, marginTop: 4, opacity: 0.9 }}>{spec.body}</div>
        </div>
      </div>
      <div style={{ position: "absolute", top: 520, width: "100%", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            transform: `scale(${pill})`,
            background: C.teal,
            color: C.navy,
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 54,
            padding: "14px 44px",
            borderRadius: 999,
            boxShadow: "0 16px 50px rgba(94,234,212,0.45)",
          }}
        >
          ✓ {spec.badge}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- shot 3: kinetic lines + highlight sweep
const Kinetic: React.FC<{ spec: MotionSpec["kinetic"]; frames: number }> = ({ spec, frames }) => {
  const f = useCurrentFrame();
  const exit = useExit(frames);
  const word = (w: string, i: number, delay: number, hl: boolean) => {
    const p = interpolate(f - delay - i * 4, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
    const bar = interpolate(f - delay - i * 4 - 8, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
    return (
      <span key={`${delay}-${i}`} style={{ display: "inline-block", position: "relative", margin: "0 14px", transform: `translateX(${(1 - p) * -120}px)`, opacity: p }}>
        {hl && (
          <span style={{ position: "absolute", left: -14, right: -14, top: 18, bottom: 8, background: C.teal, borderRadius: 14, transform: `scaleX(${bar})`, transformOrigin: "left", zIndex: 0 }} />
        )}
        <span style={{ position: "relative", zIndex: 1, color: hl && bar > 0.5 ? C.navy : C.white }}>{w}</span>
      </span>
    );
  };
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  // Fit the longest line on one row: ~0.66em per uppercase Montserrat ExtraBold glyph incl. word gaps.
  const longest = Math.max(spec.line1.length, spec.line2.length);
  const size = Math.min(118, Math.floor(940 / (longest * 0.66)));
  return (
    <AbsoluteFill style={{ opacity: exit, justifyContent: "flex-end", paddingBottom: 470 }}>
      <div style={{ textAlign: "center", whiteSpace: "nowrap", fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.18, letterSpacing: -1, textShadow: "0 8px 30px rgba(0,0,0,0.45)" }}>
        <div>{spec.line1.toUpperCase().split(/\s+/).map((w, i) => word(w, i, 2, false))}</div>
        <div>{spec.line2.toUpperCase().split(/\s+/).map((w, i) => word(w, i, 14, clean(w) === clean(spec.highlight)))}</div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- shot 4: checklist payoff
const Checklist: React.FC<{ items: string[]; frames: number }> = ({ items, frames }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit(frames, 6);
  return (
    <AbsoluteFill style={{ opacity: exit }}>
      {/* lower third: keeps the subject's face clear, above the platform UI zone */}
      <div style={{ position: "absolute", top: 1120, left: 80, display: "flex", flexDirection: "column", gap: 22 }}>
        {items.map((it, i) => {
          const p = spring({ frame: f - 4 - i * 9, fps, config: { damping: 14, stiffness: 160 } });
          const tick = interpolate(f - 10 - i * 9, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                transform: `translateX(${(1 - p) * -500}px)`,
                background: C.glass,
                backdropFilter: "blur(20px)",
                border: "1.5px solid rgba(255,255,255,0.16)",
                borderRadius: 999,
                padding: "16px 34px 16px 18px",
                fontFamily: FONT,
                fontWeight: 700,
                fontSize: 50,
                color: C.white,
              }}
            >
              <svg width={62} height={62} viewBox="0 0 62 62">
                <circle cx={31} cy={31} r={28} fill={C.teal} opacity={0.2 + 0.8 * tick} />
                <path d="M18 32 L27 41 L45 22" fill="none" stroke={C.navy} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={40} strokeDashoffset={40 * (1 - tick)} />
              </svg>
              {it}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- end card
const EndCard: React.FC<{ brand: string; headline: string; cta: string }> = ({ brand, headline, cta }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const draw = interpolate(f, [2, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const fill = interpolate(f, [18, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const letters = brand.split("");
  const rule = interpolate(f, [22, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const tag = interpolate(f, [28, 42], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const btn = spring({ frame: f - 40, fps, config: { damping: 11, stiffness: 170 } });
  const shine = interpolate(f, [56, 80], [-120, 520], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: FONT, color: C.white, paddingBottom: 120 }}>
      <div style={{ transform: `scale(${interpolate(draw, [0, 1], [0.85, 1])})` }}>
        <Shield size={190} draw={draw} fill={fill} />
      </div>
      <div style={{ fontWeight: 800, fontSize: 132, letterSpacing: -2, marginTop: 18, overflow: "hidden", height: 160, lineHeight: "160px" }}>
        {letters.map((ch, i) => {
          const p = interpolate(f - 10 - i * 1.4, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
          return (
            <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - p) * 160}px)` }}>
              {ch}
            </span>
          );
        })}
      </div>
      <div style={{ width: 220 * rule, height: 8, borderRadius: 8, background: C.teal, marginTop: 8 }} />
      <div style={{ fontWeight: 700, fontSize: 56, textAlign: "center", maxWidth: 860, lineHeight: 1.25, marginTop: 34, opacity: tag, transform: `translateY(${(1 - tag) * 30}px)` }}>
        {headline}
      </div>
      <div
        style={{
          marginTop: 56,
          transform: `scale(${btn})`,
          position: "relative",
          overflow: "hidden",
          background: C.white,
          color: C.navy,
          fontWeight: 800,
          fontSize: 52,
          padding: "26px 64px",
          borderRadius: 999,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        {cta}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: shine, width: 90, transform: "skewX(-20deg)", background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)", opacity: interpolate(shine, [-120, 0, 400, 520], [0, 1, 1, 0]) }} />
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- composition
export const Ad: React.FC<AdProps> = (p) => {
  useFonts();
  const { fps } = useVideoConfig();
  const fr = (s: number) => Math.round(s * fps);
  const sc = p.scenes;
  const seq = (i: number) => ({ from: fr(sc[i].start), durationInFrames: Math.max(1, fr(sc[i].end) - fr(sc[i].start)) });
  return (
    <AbsoluteFill style={{ background: "black" }}>
      <Footage scenes={sc} cut={p.cut} />
      <Grade />
      {sc[0] && <Sequence {...seq(0)}><Hook spec={p.spec.hook} frames={seq(0).durationInFrames} /></Sequence>}
      {sc[1] && <Sequence {...seq(1)}><ProductCard brand={p.brand} spec={p.spec.product_card} frames={seq(1).durationInFrames} /></Sequence>}
      {sc[2] && <Sequence {...seq(2)}><Kinetic spec={p.spec.kinetic} frames={seq(2).durationInFrames} /></Sequence>}
      {sc[3] && <Sequence {...seq(3)}><Checklist items={p.spec.checklist} frames={seq(3).durationInFrames} /></Sequence>}
      <Sequence from={fr(p.cut)}>
        <EndCard brand={p.brand} headline={p.endHeadline} cta={p.cta} />
      </Sequence>
      <CutFlashes scenes={sc} cut={p.cut} />
    </AbsoluteFill>
  );
};
