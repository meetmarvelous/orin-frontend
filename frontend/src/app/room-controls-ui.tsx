"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const musicCategories = ["Lo-Fi", "Ambient", "Jazz", "Classical"] as const;

const presets = [
  { label: "Relax", temperature: 22, lights: 20, music: "Jazz" },
  { label: "Focus", temperature: 21, lights: 65, music: "Lo-Fi" },
  { label: "Party", temperature: 20, lights: 85, music: "Ambient" },
  { label: "Sleep", temperature: 19, lights: 10, music: "Classical" },
] as const;

export function InteractiveRoomScreen({
  title,
  subtitle,
  backHref,
  saveHref,
  saveLabel,
  mode,
  initialTemperature,
  initialLights,
  initialMusic,
}: {
  title: string;
  subtitle: string;
  backHref: string;
  saveHref: string;
  saveLabel: string;
  mode: "setup" | "control";
  initialTemperature: number;
  initialLights: number;
  initialMusic: string;
}) {
  const [temperature, setTemperature] = useState(initialTemperature);
  const [lights, setLights] = useState(initialLights);
  const [music, setMusic] = useState(initialMusic);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const changed = useMemo(
    () =>
      temperature !== initialTemperature || lights !== initialLights || music !== initialMusic,
    [initialLights, initialMusic, initialTemperature, lights, music, temperature],
  );

  const saveEnabled = changed && music.length > 0;

  const applyPreset = (preset: (typeof presets)[number]) => {
    setSelectedPreset(preset.label);
    setTemperature(preset.temperature);
    setLights(preset.lights);
    setMusic(preset.music);
  };

  return (
    <section className="room-screen">
      <header className="room-header">
        <Link className="back-button" href={backHref}>
          <Arrow />
        </Link>
        <div className="room-header-copy">
          <strong>{title}</strong>
          <span>{subtitle} ▼</span>
        </div>
        <button className="bookmark-button" type="button">
          ⌑
        </button>
      </header>

      <div className="preset-strip">
        {presets.map((preset) => (
          <button
            className={`preset-pill ${selectedPreset === preset.label ? "preset-pill--active" : ""}`}
            key={preset.label}
            onClick={() => applyPreset(preset)}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <InteractiveControlPanel
        label="TEMPERATURE"
        max={30}
        maxLabel="30°C"
        min={16}
        minLabel="16°C"
        step={1}
        suffix="°C"
        value={temperature}
        onChange={(value) => {
          setSelectedPreset(null);
          setTemperature(value);
        }}
      />

      <InteractiveControlPanel
        label="LIGHTS"
        max={100}
        maxLabel="MAX"
        min={0}
        minLabel="OFF"
        step={5}
        suffix="%"
        value={lights}
        onChange={(value) => {
          setSelectedPreset(null);
          setLights(value);
        }}
      />

      <article className="music-panel">
        <div className="music-panel-header">
          <strong>♫ MUSIC</strong>
          <span>{music || "Select One Category"}</span>
        </div>
        <div className="music-options">
          {musicCategories.map((category) => (
            <button
              className={`music-option ${music === category ? "music-option--active" : ""}`}
              key={category}
              onClick={() => {
                setSelectedPreset(null);
                setMusic(category);
              }}
              type="button"
            >
              {category}
            </button>
          ))}
        </div>
      </article>

      {mode === "setup" ? (
        <Link
          className={`auth-primary room-save ${saveEnabled ? "auth-primary--enabled" : ""}`}
          href={saveEnabled ? saveHref : "#"}
          onClick={(event) => {
            if (!saveEnabled) event.preventDefault();
          }}
        >
          {saveLabel}
          <span className="button-arrow">→</span>
        </Link>
      ) : (
        <Link
          className={`auth-primary room-save ${saveEnabled ? "auth-primary--enabled" : ""}`}
          href={saveEnabled ? saveHref : "#"}
          onClick={(event) => {
            if (!saveEnabled) event.preventDefault();
          }}
        >
          {saveLabel}
          <span className="button-arrow">→</span>
        </Link>
      )}
    </section>
  );
}

function InteractiveControlPanel({
  label,
  value,
  min,
  max,
  minLabel,
  maxLabel,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  minLabel: string;
  maxLabel: string;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <article className="control-panel">
      <div className="control-top">
        <strong>{label}</strong>
        <b>
          {value}
          {suffix}
        </b>
      </div>
      <div className="slider-shell">
        <div className="slider-track" />
        <div className="slider-progress" style={{ width: `${percentage}%` }} />
        <input
          className="slider-input"
          max={max}
          min={min}
          onChange={(event) => onChange(Number(event.target.value))}
          step={step}
          type="range"
          value={value}
        />
      </div>
      <div className="control-range">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </article>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 5L8 12L15 19" />
    </svg>
  );
}
