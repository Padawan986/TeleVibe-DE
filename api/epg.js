import zlib from 'zlib';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const response = await fetch('https://www.free-epg.de/api/epg/de.xml.gz', {
      headers: { 'User-Agent': 'TeleVibeDE/1.0' }
    });

    if (!response.ok) {
      throw new Error(`FreeEPG Server-Fehler: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let xmlText;
    if (buffer.length > 2 && buffer[0] === 0x1F && buffer[1] === 0x8B) {
      xmlText = zlib.gunzipSync(buffer).toString('utf-8');
    } else {
      xmlText = buffer.toString('utf-8');
    }

    if (!xmlText.includes('<tv') && !xmlText.includes('<programme')) {
       return res.status(200).json({ error: "Ungültiges XML Format" });
    }

    // 1. Sender parsen
    const channelMap = {};
    const channelBlocks = xmlText.split('<channel ');
    
    for (let i = 1; i < channelBlocks.length; i++) {
      const block = channelBlocks[i];
      const endIdx = block.indexOf('</channel>');
      if (endIdx === -1) continue;
      
      const attrs = block.substring(0, block.indexOf('>'));
      const inner = block.substring(block.indexOf('>') + 1, endIdx);
      
      const idMatch = attrs.match(/id="([^"]+)"/);
      if (idMatch) {
        const nameMatch = inner.match(/<display-name[^>]*>([^<]*)<\/display-name>/);
        const name = nameMatch ? nameMatch[1].trim() : idMatch[1];
        channelMap[idMatch[1]] = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      }
    }

    // --- NEU: Wir suchen das aktuellste Datum IN DER DATEI und machen es zu "Heute" ---
    // So haben wir immer Daten zum Anzeigen, auch wenn FreeEPG veraltete Dateien liefert.
    let todayStr = "20000101"; // Fallback
    
    const alleDatumMatches = xmlText.match(/start="(\d{8})/g);
    if (alleDatumMatches && alleDatumMatches.length > 0) {
        // Sortieren und das späteste (höchste) Datum nehmen
        const alleDatumStrings = alleDatumMatches.map(m => m.replace('start="', ''));
        alleDatumStrings.sort();
        // Wir nehmen nicht den allerletzten Tag im EPG, sondern ein paar Tage davor, 
        // damit wir noch ein "+3 Tage" Fenster zum Anzeigen haben.
        const targetIndex = Math.max(0, alleDatumStrings.length - 10000); // Zirka 3-4 Tage vor dem Ende der Datei
        todayStr = alleDatumStrings[targetIndex]; 
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

    // 2. Sendungen parsen
    const schedule = [];
    const progBlocks = xmlText.split('<programme ');
    
    for (let i = 1; i < progBlocks.length; i++) {
      const block = progBlocks[i];
      const endIdx = block.indexOf('</programme>');
      if (endIdx === -1) continue;
      
      const tagEnd = block.indexOf('>');
      const attrs = block.substring(0, tagEnd);
      const inner = block.substring(tagEnd + 1, endIdx);
      
      const startMatch = attrs.match(/start="([^"]+)"/);
      const stopMatch = attrs.match(/stop="([^"]+)"/);
      const channelMatch = attrs.match(/channel="([^"]+)"/);
      
      if (!startMatch || !stopMatch || !channelMatch) continue;
      
      const startStr = startMatch[1];
      const stopStr = stopMatch[1];
      const channelId = channelMatch[1];
      
      const dayOffset = getDayOffset(startStr, todayStr);
      
      if (dayOffset >= 0 && dayOffset <= 3) {
        const titleMatch = inner.match(/<title[^>]*>([^<]*)<\/title>/);
        const descMatch = inner.match(/<desc[^>]*>([^<]*)<\/desc>/);
        
        let title = titleMatch ? titleMatch[1].trim() : 'Unbekannt';
        let desc = descMatch ? descMatch[1].trim() : 'Keine Beschreibung vorhanden.';
        
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

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ 
        simuliertesDatum: todayStr, // Sende das simulierte Datum ans Frontend
        channels, 
        schedule 
    });

  } catch (error) {
    console.error('EPG Backend Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
