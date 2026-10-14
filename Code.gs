function testReadGmail() {
  const threads = GmailApp.search('to:communication+post@sttimothy.ca');
  const thread = threads[0]
  console.log(thread.getFirstMessageSubject());
  console.log(thread.getMessageCount());
}

function testReadBody() {
  const threads = GmailApp.search('to:communication+post@sttimothy.ca');
  const message = threads[0].getMessages()[0];   // 스레드 안의 첫 메일
  const body = message.getPlainBody();           // HTML 말고 텍스트만

  console.log(body);
    const attachments = message.getAttachments();
  console.log('첨부 개수: ' + attachments.length);

  attachments.forEach(a => {
    console.log(a.getName() + ' | ' + a.getContentType() + ' | ' + a.getSize() + ' bytes');
  });
}

const MODEL = 'gemini-3.1-flash-lite';

const PROMPT = `You read event requests for a church website and return JSON only.
Return {"events": [...]}, with one item per separate program or event.
A single flyer usually has one item. A seasonal guide can have many.
Each item has these fields:
- title: short event title
- category: one of "Learning", "Community", "Volunteering", "Children"
- frequency: one of "One-Time", "Multiple-Times", "Recurring"
- start_date: "YYYY-MM-DD" or null
- end_date: "YYYY-MM-DD" or null
- time_display: e.g. "Tuesdays 10:00am-11:30am" or null
- location: room name or outside address if given. If it is just the church itself, return null.
- cost: if given, otherwise null
- description: 2-3 friendly sentences based only on the material
- missing: list of field names you could not find
  - skip: true for any worship service (prayer services, Eucharist, feast day or holiday services), donation info, or general church info. Otherwise false.
  - skip_reason: short reason if skip is true, otherwise null
  - existing_match: if this is the same program as one of the EXISTING POSTS (even with a different name), that post's exact title. Otherwise null.
- how_to_join: one short sentence on how to register or attend (RSVP, sign-up, drop-in), or null

Rules:
- Never guess dates, times, locations or costs. Use null and add to missing.
- If the email body gives an instruction (like the category), follow it.
- Do not use em dashes.`;

function extractEvent(body, attachments, existingTitles) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

  // 본문 + 첨부(PDF, 이미지)를 한 번에 보냄
  const parts = [{ text: PROMPT +
    '\n\nEXISTING POSTS ON THE WEBSITE:\n' + (existingTitles || []).join('\n') +
    '\n\nEMAIL BODY:\n' + body }];
  attachments.forEach(a => {
    const type = a.getContentType();
    if (type === 'application/pdf' || type.startsWith('image/')) {
      parts.push({ inline_data: { mime_type: type, data: Utilities.base64Encode(a.getBytes()) } });
    }
  });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({
        contents: [{ parts: parts }],
        generationConfig: { responseMimeType: 'application/json' }
      }),
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    if (code !== 503 && code !== 429) break;   // 바쁨/한도 초과가 아니면 그만
    console.log('Gemini busy (' + code + '), retry ' + attempt + '/3 in 15s');
    Utilities.sleep(15000);                      // 15초 쉬고 다시
  }

  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini error ' + res.getResponseCode() + ': ' + res.getContentText());
  }

  const text = JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

function testExtract() {
  const message = GmailApp.search('to:communication+post@sttimothy.ca')[0].getMessages()[0];
    const result = extractEvent(message.getPlainBody(), message.getAttachments(), getExistingTitles());
  console.log(JSON.stringify(result, null, 2));
}

const DEFAULT_LOCATION = '100 Old Orchard Grove, Toronto';
const CATEGORY_IDS  = { 'Learning': 261, 'Community': 262, 'Volunteering': 263, 'Children': 264 };
const FREQUENCY_IDS = { 'One-Time': 265, 'Multiple-Times': 266, 'Recurring': 267 };

function toYmd(d) {
  return d ? d.replace(/-/g, '') : '';   // "2026-11-07" → "20261107" (ACF 날짜 형식)
}

function para(html) {
  return '<!-- wp:paragraph -->\n<p>' + html + '</p>\n<!-- /wp:paragraph -->\n';
}

function li(html) {
  return '<!-- wp:list-item -->\n<li>' + html + '</li>\n<!-- /wp:list-item -->';
}

function howToJoin(data) {
  const items = [];

  // If data included to how to join data, first element of the items. 
  if (data.how_to_join) {
    items.push(li(data.how_to_join));
  }

  // Fixed list 
  items.push(li('Questions? <a href="mailto:office@sttimothy.ca">office@sttimothy.ca</a> or 416-488-0079'));
  items.push(li('See more programs on our <a href="https://sttimothy.ca/get-involved/">Get Involved</a> page'));

  // Return with data and fixed list
  return '<!-- wp:heading -->\n<h2 class="wp-block-heading">How to Join</h2>\n<!-- /wp:heading -->\n' +
         '<!-- wp:list -->\n<ul class="wp-block-list">' + items.join('') + '</ul>\n<!-- /wp:list -->\n';
}

function getExistingTitles() {
  const props = PropertiesService.getScriptProperties();
  const auth = Utilities.base64Encode(
    props.getProperty('WP_USERNAME') + ':' + props.getProperty('WP_APP_PASSWORD')
  );
  const res = UrlFetchApp.fetch(
    'https://sttimothy.ca/wp-json/wp/v2/event?status=any&per_page=100&_fields=title',
    { headers: { Authorization: 'Basic ' + auth }, muteHttpExceptions: true }
  );
  return JSON.parse(res.getContentText()).map(p => p.title.rendered);
}

function createDraft(data) {
  const props = PropertiesService.getScriptProperties();
  const auth = Utilities.base64Encode(
    props.getProperty('WP_USERNAME') + ':' + props.getProperty('WP_APP_PASSWORD')
  );

  // 기본값 처리 (어떤 게 기본값인지 기록)
  const defaults = [];
  const location = data.location || (defaults.push('location'), DEFAULT_LOCATION);
  const cost = data.cost || (defaults.push('cost'), 'Free');
  const missing = (data.missing || []).filter(f => f !== 'location' && f !== 'cost');
    const catId  = CATEGORY_IDS[data.category];
  const freqId = FREQUENCY_IDS[data.frequency];
  if (!catId)  missing.push('category');    // AI가 이상한 이름 주면 경고에 뜨게
  if (!freqId) missing.push('frequency');

  // 경고 줄
  let warning = '';
  if (missing.length || defaults.length) {
    warning = para('<strong>⚠ Missing: ' + (missing.join(', ') || 'none') +
                   ' | Default used: ' + (defaults.join(', ') || 'none') + '</strong>');
  }

  const res = UrlFetchApp.fetch('https://sttimothy.ca/wp-json/wp/v2/event', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + auth },
    payload: JSON.stringify({
      title: data.title,
      status: 'draft',
      content: warning + para(data.description) + howToJoin(data),
            gi_category:  catId  ? [catId]  : [],
      gi_frequency: freqId ? [freqId] : [],
      acf: {
        start_date: toYmd(data.start_date),
        end_date: toYmd(data.end_date),
        time_display: data.time_display || '',
        location: location,
        cost: cost
      }
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 201) {
    throw new Error('WP error ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText()).id;
}

function notify(results) {
  const d = results.drafts, e = results.existing, s = results.skipped;
  if (!d.length && !e.length && !s.length) return;   // Don't send an email if nothing to do 

  const subject = '[Email to WP] Results: ' + d.length + ' drafts / ' +
                  e.length + ' existing / ' + s.length + ' skipped';

  const lines = ['New drafts (' + d.length + ')'];
  d.forEach(x => lines.push('- ' + x));
  lines.push('', 'Already on the website (' + e.length + ')');
  e.forEach(x => lines.push('- ' + x));
  lines.push('', 'Skipped (' + s.length + ')');
  s.forEach(x => lines.push('- ' + x));

  GmailApp.sendEmail('communication@sttimothy.ca', subject, lines.join('\n'));
  Utilities.sleep(3000);   // 메일이 메일함에 들어올 때까지 3초 기다림
  const resultLabel = GmailApp.getUserLabelByName('WP Post Results') || GmailApp.createLabel('WP Post Results');
  GmailApp.search('subject:"[Email to WP]" -label:wp-post-results')
    .forEach(t => t.addLabel(resultLabel));
}

function processRequests() {
  const label = GmailApp.getUserLabelByName('wp-drafted') || GmailApp.createLabel('wp-drafted');
  const threads = GmailApp.search('to:communication+post@sttimothy.ca -label:wp-drafted');
  if (!threads.length) return;   // Return that if there is no email 

  const existing = getExistingTitles();
  const results = { drafts: [], existing: [], skipped: [] };  

  threads.forEach(thread => {
    const message = thread.getMessages()[0];
    const result = extractEvent(message.getPlainBody(), message.getAttachments(), existing);
    const events = Array.isArray(result) ? result : (result.events || []);

    events.forEach(data => {
      // ① skip block
      if (data.skip) {
        console.log('Skipped: ' + data.title + ' (' + data.skip_reason + ')');
        results.skipped.push(data.title + ' (' + data.skip_reason + ')');
        return;
      }

      // ② existing block
      if (data.existing_match) {
        console.log('Exists: ' + data.title + ' → ' + data.existing_match);
        results.existing.push(data.title + ' → ' + data.existing_match);
        return;
      }

      // ③ create the new draft
      const id = createDraft(data);
      console.log('Draft created: ' + id + ' / ' + data.title);
      const miss = (data.missing || []).filter(f => f !== 'location' && f !== 'cost');
      results.drafts.push(data.title + (miss.length ? '  ⚠ Missing: ' + miss.join(', ') : '') +
        '\n  https://sttimothy.ca/wp-admin/post.php?post=' + id + '&action=edit');
    });

    thread.addLabel(label);   // Label the executed email
  });

  notify(results);   // Send the result email
}


