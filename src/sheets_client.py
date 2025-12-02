import json
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime
from src.config import settings
from src.parser_core import ParsedExpense

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

class GoogleSheetsClient:
    def __init__(self):
        creds_dict = json.loads(settings.google_credentials_json)
        creds = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
        self.client = gspread.authorize(creds)
        self.sheet_id = settings.spreadsheet_id
        self._sheet = None
    
    @property
    def sheet(self):
        if self._sheet is None:
            self._sheet = self.client.open_by_key(self.sheet_id).sheet1
        return self._sheet
    
    def append_row(self, expense: ParsedExpense):
        now_iso = datetime.utcnow().isoformat()
        
        if expense.currency == 'RUB':
            fx = 1.0
            rub_val = expense.amount
        else:
            fx = ""
            rub_val = ""
        
        row_data = [
            now_iso,
            expense.amount,
            expense.currency,
            fx,
            rub_val,
            '',
            '',
            expense.raw_text,
            expense.source
        ]
        
        self.sheet.append_row(row_data, value_input_option='USER_ENTERED')
    
    def get_last_rows(self, n: int = 3) -> list:
        all_values = self.sheet.get_all_values()
        total_rows = len(all_values)
        
        if total_rows <= 1:
            return []
        
        start_index = max(2, total_rows - n + 1)
        data = []
        
        for i in range(start_index - 1, total_rows):
            row_content = all_values[i]
            while len(row_content) < 9:
                row_content.append("")
            
            entry = {
                "row_number": i + 1,
                "date": row_content[0],
                "amount": row_content[1],
                "currency": row_content[2],
                "description": row_content[7], # This is now the raw text
                "source": row_content[8]
            }
            data.append(entry)
        
        return data
    
    def update_row(self, row_number: int, expense: ParsedExpense):
        if expense.currency == 'RUB':
            fx = 1.0
            rub_val = expense.amount
        else:
            fx = ""
            rub_val = ""
        
        updates = [
            expense.amount,
            expense.currency,
            fx,
            rub_val,
            '',
            '',
            expense.raw_text,
            expense.source
        ]
        
        range_name = f"B{row_number}:I{row_number}"
        self.sheet.update(range_name=range_name, values=[updates], value_input_option='USER_ENTERED')

    def delete_row(self, row_number: int):
        self.sheet.delete_rows(row_number)

_sheets_client = None

def get_sheets_client() -> GoogleSheetsClient:
    global _sheets_client
    if _sheets_client is None:
        _sheets_client = GoogleSheetsClient()
    return _sheets_client