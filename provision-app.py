#!/usr/bin/env python3
"""Provision the BattleFone Jambonz application + assign the DID.

Usage: python3 provision-app.py [wss://your-tunnel-url/] [10-digit-DID]

Creates a webhook for the WSS URL, creates the application with Google TTS
(same speech config as Phone Tic-Tac-Toe / Call Snare), forces the wss://
call_hook, then registers the phone number on the app.
"""
import json
import os
import sys
import urllib.request
import urllib.error

WS_URL = sys.argv[1] if len(sys.argv) > 1 else "wss://diy-thinking-kim-copyright.trycloudflare.com/"
NUMBER = sys.argv[2] if len(sys.argv) > 2 else "13464570123"  # (346) 457-0123, E.164

# Load creds from .env.jambonz
creds = {}
env_path = os.path.expanduser("~/apps/jambonz-agent/.env.jambonz")
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip().strip('"').strip("'")

API = creds["JAMBONZ_API_BASE"]
KEY = creds["JAMBONZ_API_KEY"]


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        print(f"❌ HTTP {e.code} on {method} {path}: {e.read().decode()[:500]}")
        sys.exit(1)


print("🔧 Creating webhook...")
webhook = call("POST", "/v1/Webhooks", {"url": WS_URL, "method": "POST"})
wh_sid = webhook.get("sid")
print(f"✅ Webhook: {wh_sid}")

print("🔧 Creating application...")
app = call(
    "POST",
    "/v1/Applications",
    {
        "name": "BattleFone",
        "speech_synthesis_vendor": "google",
        "speech_synthesis_language": "en-US",
        "speech_synthesis_voice": "en-US-Wavenet-D",
        "speech_synthesis_label": "g_speech",
        "speech_recognizer_vendor": "google",
        "speech_recognizer_language": "en-US",
        "call_hook": {"webhook_sid": wh_sid, "url": WS_URL, "method": "POST"},
        "call_status_hook": {"url": "https://public-apps.jambonz.cloud/call-status", "method": "POST"},
        "env_vars": {},
    },
)
app_sid = app.get("sid")
print(f"✅ Application: {app_sid}")

print("🔧 Forcing wss:// call_hook...")
call("PUT", f"/v1/Applications/{app_sid}", {"call_hook": {"url": WS_URL, "method": "POST"}})
print("✅ wss:// confirmed")

print("🔧 Registering phone number...")
num = call("POST", "/v1/PhoneNumbers", {"number": NUMBER, "application_sid": app_sid})
print(f"✅ PhoneNumber: {num.get('sid')}")

verify = call("GET", f"/v1/Applications/{app_sid}")
print(f"\n🎉 Done! Application SID: {app_sid}")
print(f"   Name: {verify.get('name')}")
print(f"   call_hook.url: {verify.get('call_hook', {}).get('url')}")
print(f"   TTS: {verify.get('speech_synthesis_vendor')} / {verify.get('speech_synthesis_voice')}")
