// The server's memory, on Render's disk (DATA_DIR): db.json - the current release and how many times each version
// was downloaded (a number, nothing about who) - written whole through a temporary file and a rename, so a crash
// never leaves half a file. files/<channel>/... - the installer and the update files.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    this.db = { release: null, downloads: {} };
    this.timer = null;
    if (fs.existsSync(this.file)) {
      this.db = { ...this.db, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      // the download keys (removed 2026-10-09): their hashes, who used them and the links leave the disk too
      if ('keys' in this.db || 'tokens' in this.db) {
        delete this.db.keys;
        delete this.db.tokens;
        this.save();
      }
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  /** Saved a moment later (a burst of downloads writes once). */
  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), 2000);
    this.timer.unref?.();
  }

  /** A release file on the disk: files/<channel>/<name> (both checked: letters, digits, - _ .). */
  filePath(channel, name) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(channel) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) return null;
    return path.join(this.dir, 'files', channel, name);
  }
}
