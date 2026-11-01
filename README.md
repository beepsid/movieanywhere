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
- If a file has no sound or won't play (common for .mkv on iPhone), tap **Open in VLC**.
