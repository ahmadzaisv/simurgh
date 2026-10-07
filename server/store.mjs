// The server's memory, on Render's disk (DATA_DIR): db.json - the key hashes and how each was used, the download
// links handed out, the current release - written whole through a temporary file and a rename, so a crash never
// leaves half a file. files/<channel>/... - the installer and the update files.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    this.db = { keys: {}, tokens: {}, release: null };
    if (fs.existsSync(this.file)) this.db = { ...this.db, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  /** A release file on the disk: files/<channel>/<name> (both checked: letters, digits, - _ .). */
  filePath(channel, name) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(channel) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) return null;
    return path.join(this.dir, 'files', channel, name);
  }

  /** Download links older than a day are forgotten. */
  dropOldTokens(now = Date.now()) {
    let n = 0;
    for (const [t, v] of Object.entries(this.db.tokens)) if (v.expires < now) delete this.db.tokens[t], n++;
    return n;
  }
}
