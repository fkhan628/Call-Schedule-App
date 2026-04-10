# Surgical Call Schedule

A web app for managing surgical call schedules with real-time sync across devices.

## Features

- **Schedule Generator** — Auto-generates 14-week call schedules balancing day call, night shifts, weekends, and time off across 7 surgeons
- **Backup Week Support** — Handles Fierce Primary and Fierce Backup weeks
- **APP Coverage** — Manual assignment of APP night shifts
- **AI File Scanning** — Upload photos, PDFs, Excel, or Word files to auto-import:
  - Past call schedules (counts shifts per surgeon)
  - Vacation/time-off documents
  - Fierce schedules
- **Calendar Export** — Download .ics files for Google Calendar, Outlook, or Apple Calendar
- **Shareable HTML** — Generate a read-only schedule page to share with the group
- **Real-Time Sync** — All data syncs via Supabase so changes appear on every device
- **Mobile Friendly** — Works on phones, tablets, and desktop

## Setup

1. Push this repo to GitHub
2. Enable GitHub Pages: **Settings → Pages → Source: Deploy from a branch → Branch: main → Save**
3. Your app will be live at `https://yourusername.github.io/your-repo-name/`

## Database (Supabase)

The app connects to a Supabase database for shared data storage. The database is already configured — no additional setup needed.

## AI Scanning

File scanning features require an Anthropic API key. Enter it once in **Setup → ⚙️ Settings** and it's shared with all users of the app.

Get a key at [console.anthropic.com](https://console.anthropic.com)

## Usage

Share the GitHub Pages URL with your surgeons and schedulers. Everyone sees the same schedule in real time.
