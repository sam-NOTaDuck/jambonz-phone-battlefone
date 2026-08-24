#!/usr/bin/env python3
"""Generate the BattleFone narration phrase bank (TTS clips).

Every phrase BattleFone speaks is finite, so we pre-generate ALL narration as
audio clips (ElevenLabs Harry - Fierce Warrior, eleven_flash_v2_5) instead of
live TTS. This eliminates the intermittent jambonz Google-TTS speed glitch
entirely and gives the game a consistent announcer voice.

Outputs: data/audio/tts/{slug}.mp3 (local presence gate) + uploads to S3
audio/battlefone/tts/{slug}.mp3 (actual playback source).
"""
import json
import os
import subprocess
import urllib.request
import urllib.error

VOICE = "pNInz6obpgDQGcFmaJgB"  # Adam - Dominant, Firm (premade = free plan)
MODEL = "eleven_flash_v2_5"
API = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}"

LOCAL_TTS = "/home/sam/apps/battlefone/data/audio/tts"
os.makedirs(LOCAL_TTS, exist_ok=True)

# Load creds
env = {}
for path in ["/home/sam/apps/jambonz-agent/.env.jambonz"]:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")

ELEVEN_KEY = env["ELEVENLABS_API_KEY"]

PHRASES = [
    # (slug, text)
    ("welcome", "Welcome to BattleFone. Press 1 for instant action, or 5 for options."),
    ("menu", "Press 1 for instant action, or 5 for options."),
    ("ship-count", "How many ships? Press 1, 2, or 3."),
    ("ship-sizes", "Ship sizes. Press 1 for all one-cell ships. Press 2 for one two-cell ship and the rest one-cell. Press 3 for random sizes."),
    ("fleet-saved", "Fleet saved."),
    ("rematch", "Press star to play again. Press pound for the main menu."),
    ("still-turn", "Still your turn. Target a cell: zero through nine."),
    ("your-turn", "Your turn. Target a cell: zero through nine."),
    ("enemy-firing", "Enemy firing."),
    ("goodbye", "Thanks for playing. Goodbye."),
    ("miss", "Miss."),
    ("hit", "Hit!"),
    ("sank", "Hit! You sank the enemy's ship!"),
    ("they-hit", "They hit your ship."),
    ("they-sank", "They sank your ship!"),
    ("win", "You sank the entire enemy fleet! Every last ship is at the bottom of the ocean. Victory! Thanks for playing BattleFone."),
    ("lose", "All of your ships have been sunk. The enemy fleet claims victory. Thanks for playing BattleFone."),
    # fleet variants
    ("fleet-set-1", "Your fleet is set. Enemy fleet: 1 ship. Fire when ready. Your turn. Target a cell: zero through nine."),
    ("fleet-set-2", "Your fleet is set. Enemy fleet: 2 ships. Fire when ready. Your turn. Target a cell: zero through nine."),
    ("fleet-set-3", "Your fleet is set. Enemy fleet: 3 ships. Fire when ready. Your turn. Target a cell: zero through nine."),
    ("fleet-remaining-1", "Enemy fleet: 1 ship remaining."),
    ("fleet-remaining-2", "Enemy fleet: 2 ships remaining."),
    ("fleet-remaining-3", "Enemy fleet: 3 ships remaining."),
] + [
    (f"shot-on-{w}", f"Shot on {w}.")
    for w in ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
] + [
    (f"enemy-fired-{w}", f"Enemy fired on {w}.")
    for w in ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
] + [
    (f"already-fired-{w}", f"You already fired at {w}. Pick a new target.")
    for w in ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
]

TOTAL_CHARS = sum(len(t) for _, t in PHRASES)
print(f"{len(PHRASES)} phrases, {TOTAL_CHARS} chars total")


def synthesize(text: str) -> bytes:
    body = json.dumps({
        "text": text,
        "model_id": MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }).encode()
    req = urllib.request.Request(
        API,
        data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def upload_s3(local_path, s3_key):
    import boto3
    s3 = boto3.client(
        "s3",
        aws_access_key_id=env["AWS_S3_ACCESS_KEY"],
        aws_secret_access_key=env["AWS_S3_SECRET_KEY"],
        region_name=env.get("AWS_S3_REGION", "us-east-1"),
    )
    s3.upload_file(local_path, env["AWS_S3_BUCKET"], s3_key, ExtraArgs={"ContentType": "audio/mpeg"})


if __name__ == "__main__":
    import sys
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for slug, text in PHRASES:
        if only and only not in slug:
            continue
        local = os.path.join(LOCAL_TTS, f"{slug}.mp3")
        if os.path.exists(local) and os.path.getsize(local) > 2000:
            print(f"  skip {slug} (exists)")
            continue
        print(f"  synth {slug} ...")
        audio = synthesize(text)
        with open(local, "wb") as f:
            f.write(audio)
        upload_s3(local, f"audio/battlefone/tts/{slug}.mp3")
        print(f"    {len(audio)/1024:.0f} KB -> local + S3")
    print("Done.")
