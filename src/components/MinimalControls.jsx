export default function MinimalControls({ running, speed, onStart, onPause, onReset, onSpeedChange }) {
  return (
    <div className="controls" role="group" aria-label="Animation controls">
      <button type="button" onClick={onStart} disabled={running}>start</button>
      <button type="button" onClick={onPause} disabled={!running}>pause</button>
      <button type="button" onClick={onReset}>reset</button>
      <input
        type="range"
        min="0.25"
        max="3"
        step="0.25"
        value={speed}
        onChange={(event) => onSpeedChange(Number(event.target.value))}
        aria-label="Speed"
      />
    </div>
  )
}