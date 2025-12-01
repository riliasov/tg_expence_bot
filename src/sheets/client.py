import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime
from src.config import GOOGLE_CREDS_DICT, SPREADSHEET_ID
from src.parser.core import ParsedExpense

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

class GoogleSheetsClient:
    def __init__(self):
        creds = Credentials.from_service_account_info(GOOGLE_CREDS_DICT, scopes=SCOPES)
        self.client = gspread.authorize(creds)
        self.sheet_id = SPREADSHEET_ID
        self._sheet = None

    @property
    def sheet(self):
        if self._sheet is None:
            self._sheet = self.client.open_by_key(self.sheet_id).sheet1
        return self._sheet

    def append_row(self, expense: ParsedExpense):
        # Columns: Date | Amount | Currency | FX | RUB | Category | SubCategory | Description | Account
        now_iso = datetime.utcnow().isoformat()
        fx = 1
        rub_val = expense.amount * fx
        
        row_data = [
            now_iso,                # Date
            expense.amount,         # Amount
            expense.currency,       # Currency
            fx,                     # FX
            rub_val,                # RUB
            "",                     # Category
            "",                     # SubCategory
            expense.description,    # Description
            expense.source          # Account
        ]
        
        self.sheet.append_row(row_data, value_input_option='USER_ENTERED')

    def get_last_rows(self, n: int = 3):
        """Returns list of dicts with data and actual row number"""
        # Get all values to ensure we have the count
        # Optimization: In high volume sheets, this might be slow, 
        # but acceptable for personal use.
        all_values = self.sheet.get_all_values()
        total_rows = len(all_values)
        
        if total_rows <= 1: # Header only or empty
            return []

        start_index = max(2, total_rows - n + 1)
        data = []
        
        # Slicing the list locally to avoid complex API range calls for small N
        # all_values[0] is header, rows start at index 1 (which is row 2 in sheets)
        
        for i in range(start_index - 1, total_rows):
            row_content = all_values[i]
            # Ensure row has enough columns
            while len(row_content) < 9:
                row_content.append("")
            
            entry = {
                "row_number": i + 1, # 1-based index for API
                "date": row_content[0],
                "amount": row_content[1],
                "currency": row_content[2],
                "description": row_content[7],
                "source": row_content[8]
            }
            data.append(entry)
            
        return data

    def update_row(self, row_number: int, expense: ParsedExpense):
        # Range B{row}:I{row} covers Amount to Account (skipping Date at A)
        # However, requirement says strictly specific order.
        # We will update specific cells to preserve Date if needed, 
        # or update all calculated fields.
        
        fx = 1
        rub_val = expense.amount * fx
        
        # Columns: B=Amount, C=Currency, D=FX, E=RUB, F=Cat, G=SubCat, H=Desc, I=Account
        # Corresponds to indices 2, 3, 4, 5, 6, 7, 8, 9
        
        updates = [
            expense.amount,         # B
            expense.currency,       # C
            fx,                     # D
            rub_val,                # E
            "",                     # F
            "",                     # G
            expense.description,    # H
            expense.source          # I
        ]
        
        # Range string e.g. "B5:I5"
        range_name = f"B{row_number}:I{row_number}"
        self.sheet.update(range_name=range_name, values=[updates], value_input_option='USER_ENTERED')
