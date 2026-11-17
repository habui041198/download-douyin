// Google Apps Script: receives log rows from /api/download and appends them to a sheet.
// Setup: Project Settings -> Script properties -> add SECRET (same value as LOG_WEBHOOK_SECRET on Vercel).
// Deploy -> New deployment -> Web app -> Execute as: Me, Who has access: Anyone.

const SHEET_NAME = 'logs';
const HEADERS = ['time', 'event', 'ip', 'link', 'video_page', 'video_id', 'resolve_ms', 'source', 'ratio', 'error'];

function doPost(e) {
  const data = JSON.parse(e.postData.contents || '{}');
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || data.secret !== secret) return ContentService.createTextOutput('forbidden');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

  sheet.appendRow([
    new Date(),
    data.event || '',
    data.ip || '',
    data.link || '',
    data.video_page || '',
    data.video_id || '',
    data.resolve_ms ?? '',
    data.source || '',
    data.ratio || '',
    data.error || '',
  ]);
  return ContentService.createTextOutput('ok');
}
