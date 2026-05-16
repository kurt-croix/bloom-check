#!/usr/bin/env python3
"""
Generate narration for Blossom Explorer demo video using edge-tts.
Builds a timed audio track matching each clip, then muxes into final MP4.
"""
import asyncio
import subprocess
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # blovm/
CLIPS_DIR = ROOT / "test-results" / "demo-clips"
AUDIO_DIR = ROOT / "test-results" / "demo-audio"
FINAL_VIDEO = ROOT / "blossom-explorer-demo-narrated.mp4"
SOURCE_VIDEO = ROOT / "blossom-explorer-demo.webm"

VOICE = "en-US-GuyNeural"

# Ordered narration per clip. Match clip order: trans1, act1, trans2, act2, ...
# (clip_filename, narration_text)
NARRATION_SCRIPT = [
    ("trans1.webm", "Act One. Uploading files."),
    ("act1.webm",
     "First, we connect using a browser extension that holds our identity. "
     "The workspace starts empty. "
     "We click Upload Files and pick several files: a readme, a spreadsheet, an image, audio, and a document. "
     "Each file gets a unique digital fingerprint so we can tell if it ever changes. "
     "We click the readme to preview it right in the browser."),

    ("trans2.webm", "Act Two. Sharing files."),
    ("act2.webm",
     "Anyone can browse your files without logging in. "
     "We navigate to the owner's public page. "
     "The file list loads automatically from the network. "
     "Clicking the readme shows its content, no account needed."),

    ("trans3.webm", "Act Three. Recording a baseline."),
    ("act3.webm",
     "A trusted verifier opens the audit page and logs in. "
     "They enter the file owner's address and create a baseline snapshot. "
     "This records every file's fingerprint at this moment in time. "
     "The snapshot is saved on the network so it can't be tampered with. "
     "Later, we'll compare against this to detect any changes."),

    ("trans4.webm", "Act Four. Modifying a file."),
    ("act4.webm",
     "The file owner reconnects and previews the current readme. "
     "Then they upload a new version with the same filename but different content. "
     "The new file gets a different fingerprint, proving the content changed. "
     "The old version is still stored separately. "
     "Previewing the readme now shows the updated content."),

    ("trans5.webm", "Act Five. Detecting changes."),
    ("act5.webm",
     "The verifier returns and creates a new snapshot. "
     "This time, the audit compares current fingerprints against the baseline. "
     "It flags the readme as changed, highlighted in red. "
     "Clicking the file shows both versions side by side. "
     "Added lines appear in green, removed lines in red, so you can see exactly what was different. "
     "That's Blossom Explorer. Upload files, share them, and verify nobody changed them without you knowing."),
]


async def generate_audio(text: str, output_path: Path):
    import edge_tts
    communicate = edge_tts.Communicate(text, VOICE, rate="-5%")
    await communicate.save(str(output_path))


def get_duration(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
        capture_output=True, text=True
    )
    return float(json.loads(r.stdout)["format"]["duration"])


def generate_silence(duration_s: float, output_path: Path):
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "anullsrc=r=24000:cl=mono",
        "-t", str(duration_s), "-c:a", "libmp3lame", "-b:a", "64k",
        str(output_path)
    ], capture_output=True)


def pad_or_speed_audio(audio_path: Path, target_duration: float, output_path: Path):
    """Adjust audio to match target duration. Pad shorter, speed up longer."""
    aud_dur = get_duration(audio_path)

    if aud_dur <= target_duration:
        pad_duration = target_duration - aud_dur
        if pad_duration > 0.05:
            silence_path = output_path.parent / f"silence-{output_path.stem}.mp3"
            generate_silence(pad_duration, silence_path)
            list_file = output_path.parent / f"pad-list-{output_path.stem}.txt"
            list_file.write_text(
                f"file '{audio_path.resolve()}'\nfile '{silence_path.resolve()}'\n"
            )
            subprocess.run([
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(list_file), "-c:a", "libmp3lame", "-b:a", "64k",
                str(output_path)
            ], capture_output=True)
        else:
            subprocess.run(["cp", str(audio_path), str(output_path)], capture_output=True)
    else:
        speed = aud_dur / target_duration
        filters = []
        remaining = speed
        while remaining > 2.0:
            filters.append("atempo=2.0")
            remaining /= 2.0
        filters.append(f"atempo={remaining}")
        atempo = ",".join(filters)

        subprocess.run([
            "ffmpeg", "-y", "-i", str(audio_path),
            "-filter:a", atempo,
            "-c:a", "libmp3lame", "-b:a", "64k",
            str(output_path)
        ], capture_output=True)


async def main():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: Generate raw TTS
    print(f"Generating {len(NARRATION_SCRIPT)} audio segments...")
    for i, (clip_name, text) in enumerate(NARRATION_SCRIPT):
        raw_path = AUDIO_DIR / f"raw-{i:03d}.mp3"
        print(f"  [{i+1}/{len(NARRATION_SCRIPT)}] {text[:60]}...")
        await generate_audio(text, raw_path)

    # Step 2: Time each segment to match clip duration
    print("\nTiming audio to match video clips...")
    timed_segments = []
    for i, (clip_name, _) in enumerate(NARRATION_SCRIPT):
        clip_path = CLIPS_DIR / clip_name
        raw_audio = AUDIO_DIR / f"raw-{i:03d}.mp3"
        timed_audio = AUDIO_DIR / f"timed-{i:03d}.mp3"

        if not clip_path.exists() or not raw_audio.exists():
            print(f"  SKIP {clip_name}")
            continue

        clip_dur = get_duration(clip_path)
        print(f"  [{i+1}] {clip_name} ({clip_dur:.1f}s)...")
        pad_or_speed_audio(raw_audio, clip_dur, timed_audio)

        if timed_audio.exists():
            timed_segments.append(timed_audio)

    # Step 3: Concat into single audio track
    print("\nConcatenating audio track...")
    concat_list = AUDIO_DIR / "final-audio-list.txt"
    concat_list.write_text("\n".join(
        f"file '{s.resolve()}'" for s in timed_segments
    ))

    final_audio = AUDIO_DIR / "final-narration.mp3"
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_list), "-c:a", "libmp3lame", "-b:a", "64k",
        str(final_audio)
    ], capture_output=True)

    # Step 4: Mux into MP4 (H264+AAC) for broad compatibility
    print("Encoding narrated video (H264+AAC MP4)...")
    subprocess.run([
        "ffmpeg", "-y",
        "-i", str(SOURCE_VIDEO.resolve()),
        "-i", str(final_audio),
        "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-shortest",
        str(FINAL_VIDEO.resolve())
    ])

    if FINAL_VIDEO.exists():
        dur = get_duration(FINAL_VIDEO)
        size_mb = FINAL_VIDEO.stat().st_size / (1024 * 1024)
        print(f"\nDone! {FINAL_VIDEO}")
        print(f"  Duration: {dur:.1f}s | Size: {size_mb:.1f}MB")
    else:
        print("\nERROR: Final mux failed")


if __name__ == "__main__":
    asyncio.run(main())
