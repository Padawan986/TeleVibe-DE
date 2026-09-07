import zlib from 'zlib';

export default async function handler(req, res) {
  // CORS für Browser freigeben
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Komprimierte EPG-Datei von FreeEPG laden
    const response = await fetch('https://www.free-epg.de/api/epg/de.xml.gz', {
      headers: { 
        'User-Agent': 'TeleVibeDE/1.0',
        'Accept-Encoding': 'gzip, deflate'
      }
    });

    if (!response.ok) {
      throw new Error(`FreeEPG Server-Fehler: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let xmlText;
    // Prüfen, ob Datei komprimiert ist (GZIP Magic Bytes: 1F 8B)
    if (buffer[0] === 0x1F && buffer[1] === 0x8B) {
      const decompressed = zlib.gunzipSync(buffer);
      xmlText = decompressed.toString('utf-8');
    } else {
      xmlText = buffer.toString('utf-8');
    }

    // 2. Sender extrahieren (ID -> Name) - reihenfolgeunabhängig
    const channelMap = {};
    const channelRegex = /<channel\s+([^>]+)>([\s\S]*?)<\/channel>/g;
    let match;
    while ((match = channelRegex.exec(xmlText)) !== null) {
      const attrStr = match[1];
      const content = match[2];
      
      const idMatch = attrStr.match(/id="([^"]+)"/);
      const nameMatch = content.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
      
      if (idMatch && nameMatch) {
        const id = idMatch[1];
        const name = nameMatch[1]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        channelMap[id] = name;
      }
    }

    // Hilfsfunktionen für Datum & Uhrzeit
    function getTodayYYYYMMDD() {
      const now = new Date();
      const options = { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' };
      const formatter = new Intl.DateTimeFormat('en-CA', options); // Ausgabe: YYYY-MM-DD
      return formatter.format(now).replace(/-/g, '');
    }

    function getDayOffset(progDateStr, todayStr) {
      if (!progDateStr || progDateStr.length < 8) return -999;
      const pY = parseInt(progDateStr.substring(0,4)), pM = parseInt(progDateStr.substring(4,6))-1, pD = parseInt(progDateStr.substring(6,8));
      const tY = parseInt(todayStr.substring(0,4)), tM = parseInt(todayStr.substring(4,6))-1, tD = parseInt(todayStr.substring(6,8));
      const pDate = Date.UTC(pY, pM, pD);
      const tDate = Date.UTC(tY, tM, tD);
      return Math.round((pDate - tDate) / (1000 * 60 * 60 * 24));
    }

    function formatTime(str) {
      if (!str || str.length < 12) return '00:00';
      return str.substring(8, 10) + ':' + str.substring(10, 12);
    }

    const todayStr = getTodayYYYYMMDD();

    // 3. Sendungen extrahieren (reihenfolgeunabhängig)
    const progRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/g;
    const titleRegex = /<title[^>]*>([^<]+)<\/title>/;
    const descRegex = /<desc[^>]*>([^<]+)<\/desc>/;

    const schedule = [];

    while ((match = progRegex.exec(xmlText)) !== null) {
      const attrStr = match[1];
      const content = match[2];

      const startMatch = attrStr.match(/start="([^"]+)"/);
      const stopMatch = attrStr.match(/stop="([^"]+)"/);
      const channelMatch = attrStr.match(/channel="([^"]+)"/);

      if (!startMatch || !stopMatch || !channelMatch) continue;

      const startStr = startMatch[1];
      const stopStr = stopMatch[1];
      const channelId = channelMatch[1];

      const dayOffset = getDayOffset(startStr, todayStr);

      // Nur Sendungen von Heute bis in 3 Tagen speichern
      if (dayOffset >= 0 && dayOffset <= 3) {
        const titleMatch = content.match(titleRegex);
        const descMatch = content.match(descRegex);

        const title = titleMatch ? titleMatch[1] : 'Unbekannt';
        const desc = descMatch ? descMatch[1] : 'Keine Beschreibung vorhanden.';

        const channelName = channelMap[channelId] || channelId;

        schedule.push({
          dayOffset,
          channel: channelName,
          start: formatTime(startStr),
          end: formatTime(stopStr),
          title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
          desc: desc.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        });
      }
    }

    const channels = Array.from(new Set(schedule.map(s => s.channel))).sort();

    // Vercel Edge Cache: Speichert das Ergebnis für 1 Stunde
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ channels, schedule });

  } catch (error) {
    console.error('EPG Backend Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
