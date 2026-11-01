# movieanywhere
Watch the movies on your laptop from any device on the same home Wi-Fi — phone, TV or another laptop.

## Start
Double-click `start.bat` (or run `node server.js`). It prints two links:

- `http://localhost:8080` for this laptop
- `http://192.168.x.x:8080` for your phone or TV (they must be on the same Wi-Fi)

Open the link, browse the folders, pick a movie and it plays.

The first time you run it, Windows Firewall asks for permission. Tick **Private networks** only and leave **Public** unticked.

## Settings
- Movies folder: `C:\local\movie` by default. To use another folder, set the `MOVIE_DIR` environment variable.
- Port: `8080` by default. To use another port, set the `PORT` environment variable.

## Notes
- Only devices on your local network can connect. Requests from outside it are refused.
- Seeking works. Each device remembers where you stopped and picks up from there.
- If a subtitle file (`movie.srt` or `movie.vtt`) is next to the movie, it is loaded automatically.
- On a TV browser, use the arrow keys on the remote to move around and Back to go up a level.
- If a file has no sound or won't play, tap **Open in VLC**.

## Sound and .mkv files
Browsers can't play Dolby (AC3/E-AC3) or DTS audio, and iPhones can't open .mkv files. If [ffmpeg](https://ffmpeg.org) is installed (`winget install Gyan.FFmpeg`), the first time you open one of these files the server makes a browser-friendly MP4 copy:

- The video is copied unchanged, so quality stays the same and it's fast. A 5 GB file takes about 5 minutes.
- The audio is converted to AAC stereo.
- Subtitles inside the file are extracted.

The page shows progress while this runs, and after that the file plays instantly on every device. Copies are kept in the `cache/` folder and take about as much space as the originals. Delete that folder any time to free the space.
