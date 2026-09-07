import zlib from 'zlib';

export default async function handler(req, res) {
  // CORS für Browser freigeben
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Datei laden
    const response = await fetch('https://www.free-epg.de/api/epg/de.xml.gz', {
      headers: { 'User-Agent': 'TeleVibeDE/1.0' }
    });

    if (!response.ok) {
      throw new Error(`FreeEPG Server-Fehler: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let xmlText;
    // Prüfen, ob die Datei GZIP-komprimiert ist
    if (buffer.length > 2 && buffer[0] === 0x1F && buffer[1] === 0x8B) {
      xmlText = zlib.gunzipSync(buffer).toString('utf-8');
    } else {
      xmlText = buffer.toString('utf-8');
    }

    // Sicherstellen, dass es wirklich eine XMLTV-Datei ist
    if (!xmlText.includes('<tv') && !xmlText.includes('<programme')) {
       return res.status(200).json({
         error: "Ungültiges XML Format empfangen",
         preview: xmlText.substring(0, 500)
       });
    }

    // 2. Sender parsen (mit schneller Split-Methode statt RegEx)
    const channelMap = {};
    const channelBlocks = xmlText.split('<channel ');
    
    for (let i = 1; i < channelBlocks.length; i++) {
      const block = channelBlocks[i];
      const endIdx = block.indexOf('</channel>');
      if (endIdx === -1) continue;
      
      const channelContent = block.substring(0, endIdx);
      const tagEnd = channelContent.indexOf('>');
      if (tagEnd === -1) continue;
      
      const attrs = channelContent.substring(0, tagEnd);
      const inner = channelContent.substring(tagEnd + 1);
      
      const idMatch = attrs.match(/id="([^"]+)"/);
      if (idMatch) {
        const id = idMatch[1];
        const nameMatch = inner.match(/<display-name[^>]*>([^<]*)<\/display-name>/);
        const name = nameMatch ? nameMatch[1].trim() : id;
        channelMap[id] = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      }
    }

    // 3. Sicheres Datum für Heute in Berlin-Zeit ermitteln (YYYYMMDD)
    function getTodayYYYYMMDD() {
      const now = new Date();
      const berlinTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Berlin"}));
      const y = berlinTime.getFullYear();
      const m = String(berlinTime.getMonth() + 1).padStart(2, '0');
      const d = String(berlinTime.getDate()).padStart(2, '0');
      return `${y}${m}${d}`;
    }

    function getDayOffset(progDateStr, todayStr) {
      if (!progDateStr || progDateStr.length < 8) return -999;
      const pY = parseInt(progDateStr.substring(0,4), 10);
      const pM = parseInt(progDateStr.substring(4,6), 10) - 1;
      const pD = parseInt(progDateStr.substring(6,8), 10);
      
      const tY = parseInt(todayStr.substring(0,4), 10);
      const tM = parseInt(todayStr.substring(4,6), 10) - 1;
      const tD = parseInt(todayStr.substring(6,8), 10);
      
      const pDate = Date.UTC(pY, pM, pD);
      const tDate = Date.UTC(tY, tM, tD);
      return Math.round((pDate - tDate) / (1000 * 60 * 60 * 24));
    }

    function formatTime(str) {
      if (!str || str.length < 12) return '00:00';
      return str.substring(8, 10) + ':' + str.substring(10, 12);
    }

    const todayStr = getTodayYYYYMMDD();
    
    // 4. Sendungen parsen
    const schedule = [];
    const progBlocks = xmlText.split('<programme ');
    
    for (let i = 1; i < progBlocks.length; i++) {
      const block = progBlocks[i];
      const endIdx = block.indexOf('</programme>');
      if (endIdx === -1) continue;
      
      const progContent = block.substring(0, endIdx);
      const tagEnd = progContent.indexOf('>');
      if (tagEnd === -1) continue;
      
      const attrs = progContent.substring(0, tagEnd);
      const inner = progContent.substring(tagEnd + 1);
      
      // Sucht Attribute im ersten Tag
      const startMatch = attrs.match(/start="([^"]+)"/);
      const stopMatch = attrs.match(/stop="([^"]+)"/);
      const channelMatch = attrs.match(/channel="([^"]+)"/);
      
      if (!startMatch || !stopMatch || !channelMatch) continue;
      
      const startStr = startMatch[1];
      const stopStr = stopMatch[1];
      const channelId = channelMatch[1];
      
      // Vergleichen wir das Datum aus dem XML mit dem heutigen Datum
      const dayOffset = getDayOffset(startStr, todayStr);
      
      // Nur Sendungen von "Heute" (0) bis "In 3 Tagen" (3) aufnehmen
      if (dayOffset >= 0 && dayOffset <= 3) {
        const titleMatch = inner.match(/<title[^>]*>([^<]*)<\/title>/);
        const descMatch = inner.match(/<desc[^>]*>([^<]*)<\/desc>/);
        
        let title = titleMatch ? titleMatch[1].trim() : 'Unbekannt';
        let desc = descMatch ? descMatch[1].trim() : 'Keine Beschreibung vorhanden.';
        
        // HTML Entitäten aufräumen
        title = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        desc = desc.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        
        schedule.push({
          dayOffset,
          channel: channelMap[channelId] || channelId,
          start: formatTime(startStr),
          end: formatTime(stopStr),
          title,
          desc
        });
      }
    }

    const channels = Array.from(new Set(schedule.map(s => s.channel))).sort();

    // 5. DEBUG-Hilfe: Falls weiterhin alles leer ist!
    if (schedule.length === 0) {
        return res.status(200).json({ 
            channels: [], 
            schedule: [],
            debugInfo: {
                message: "Keine Sendungen im Zeitfenster (Heute bis +3 Tage) gefunden.",
                heuteDatum: todayStr,
                anzahlAlleSendungenImXML: progBlocks.length - 1,
                beispielDatum1: progBlocks[1] ? progBlocks[1].substring(0, 80).match(/start="([^"]+)"/)?.[1] : null,
                beispielDatum2: progBlocks[200] ? progBlocks[200].substring(0, 80).match(/start="([^"]+)"/)?.[1] : null,
            }
        });
    }

    // Alles hat geklappt -> Daten senden
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ channels, schedule });

  } catch (error) {
    console.error('EPG Backend Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
