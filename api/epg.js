import zlib from 'zlib';

export default async function handler(req, res) {
  // CORS für Browser freigeben
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Komprimierte EPG-Datei von FreeEPG laden (~3MB statt 60MB)
    const response = await fetch('https://www.free-epg.de/api/epg/de.xml.gz', {
      headers: { 'User-Agent': 'TeleVibeDE/1.0' }
    });

    if (!response.ok) {
      throw new Error(`FreeEPG Server-Fehler: HTTP ${response.status}`);
    }

    // 2. Im Speicher entpacken (Gzip -> XML)
    const arrayBuffer = await response.arrayBuffer();
    const decompressed = zlib.gunzipSync(Buffer.from(arrayBuffer));
    const xmlText = decompressed.toString('utf-8');

    // 3. Sender extrahieren (ID -> Name)
    const channelMap = {};
    const channelRegex = /<channel\s+id="([^"]+)">[\s\S]*?<display-name[^>]*>([^<]+)<\/display-name>/g;
    let match;
    while ((match = channelRegex.exec(xmlText)) !== null) {
      const id = match[1];
      const name = match[2]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      channelMap[id] = name;
    }

    // Hilfsfunktion: Datums-Parsing
    function parseXmltvDate(str) {
      if (!str || str.length < 14) return new Date();
      try {
        const y = str.substring(0,4), m = str.substring(4,6), d = str.substring(6,8);
        const h = str.substring(8,10), min = str.substring(10,12), s = str.substring(12,14);
        let tz = "+00:00";
        if (str.length >= 19) {
          tz = str.substring(15,18) + ":" + str.substring(18,20);
        }
        return new Date(`${y}-${m}-${d}T${h}:${min}:${s}${tz}`);
      } catch(e) {
        return new Date();
      }
    }

    function formatTime(dt) {
      return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 4. Sendungen extrahieren
    const progRegex = /<programme\s+start="([^"]+)"\s+stop="([^"]+)"\s+channel="([^"]+)">([\s\S]*?)<\/programme>/g;
    const titleRegex = /<title[^>]*>([^<]+)<\/title>/;
    const descRegex = /<desc[^>]*>([^<]+)<\/desc>/;

    const schedule = [];

    while ((match = progRegex.exec(xmlText)) !== null) {
      const startStr = match[1];
      const stopStr = match[2];
      const channelId = match[3];
      const content = match[4];

      const startDt = parseXmltvDate(startStr);
      const stopDt = parseXmltvDate(stopStr);

      const showDay = new Date(startDt);
      showDay.setHours(0, 0, 0, 0);
      const dayOffset = Math.round((showDay - today) / (1000 * 60 * 60 * 24));

      // Nur Sendungen von Heute bis in 3 Tagen speichern
      if (dayOffset >= 0 && dayOffset <= 3) {
        const titleMatch = content.match(titleRegex);
        const descMatch = content.match(descRegex);

        const title = titleMatch ? titleMatch[1] : 'Unbekannt';
        const desc = descMatch ? descMatch[1] : 'Keine Beschreibung vorhanden.';

        schedule.push({
          dayOffset,
          channel: channelMap[channelId] || channelId,
          start: formatTime(startDt),
          end: formatTime(stopDt),
          title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
          desc: desc.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        });
      }
    }

    const channels = Array.from(new Set(schedule.map(s => s.channel))).sort();

    // Vercel Edge Caching: Speichert die Antwort für 1 Stunde auf Vercel-Servern
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ channels, schedule });

  } catch (error) {
    console.error('EPG Backend Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
