// Sample data for the theme gallery. Synthetic, labelled as such in the UI.
import { ME, allocate, type Expense, type Group } from './logic'
import type { State } from './store'

let n = 0
function x(title: string, cat: string, rupees: number, payer: string, among: string[], date: string, extra: Partial<Expense> = {}): Expense {
  const amount = rupees * 100
  return { id: 'd' + n++, title, cat, date, amount, paid: { [payer]: amount }, owed: allocate(amount, Object.fromEntries(among.map(m => [m, 1]))), mode: 'equal', ...extra }
}
const goaAll = [ME, 'rahul', 'neha', 'karan', 'meera']

export const DEMO: State = {
  me: { name: 'Arjun Sharma', upi: 'arjun@okhdfcbank' },
  theme: 'classic',
  tone: 'gentle',
  groups: [
    {
      id: 'goa', name: "Goa '26", kind: 'trip', theme: 'goa',
      members: [{ id: ME, name: 'Me' }, { id: 'rahul', name: 'Rahul', upi: 'rahul.k@oksbi' }, { id: 'neha', name: 'Neha' }, { id: 'karan', name: 'Karan' }, { id: 'meera', name: 'Meera' }],
      expenses: [
        x('Airbnb, Assagao', 'stay', 9400, ME, goaAll, '2026-09-12'),
        x("Dinner at Fisherman's Wharf", 'food', 3260, 'rahul', goaAll, '2026-09-12'),
        x('Petrol', 'transport', 850, 'karan', goaAll, '2026-09-13'),
        x('Beers at Curlies', 'drinks', 2100, ME, [ME, 'rahul', 'karan'], '2026-09-13'),
        x('Club entry', 'fun', 1800, 'neha', goaAll, '2026-09-13'),
        x('Scooty rental', 'transport', 1500, ME, goaAll, '2026-09-14'),
        { id: 'dset', title: 'Settlement', cat: 'check', date: '2026-09-15', amount: 180000, paid: { neha: 180000 }, owed: { [ME]: 180000 }, settle: true },
      ],
    },
    {
      id: 'flat', name: 'Flat 404', kind: 'home', theme: 'matcha',
      members: [{ id: ME, name: 'Me' }, { id: 'aditi', name: 'Aditi' }, { id: 'rohan', name: 'Rohan' }, { id: 'kunal', name: 'Kunal' }],
      expenses: [
        x('September rent', 'rent', 54000, 'aditi', [ME, 'aditi', 'rohan', 'kunal'], '2026-09-01', { repeat: { next: '2026-10-01', day: 1 } }),
        x('Airtel Wi-Fi', 'bills', 1299, ME, [ME, 'aditi', 'rohan', 'kunal'], '2026-09-03'),
        x('Cook, September', 'help', 6500, 'rohan', [ME, 'aditi', 'rohan', 'kunal'], '2026-09-05'),
        x('BESCOM electricity', 'bills', 2843, 'aditi', [ME, 'aditi', 'rohan', 'kunal'], '2026-09-18'),
        x('Blinkit groceries', 'groceries', 1845, ME, [ME, 'aditi', 'rohan', 'kunal'], '2026-09-21'),
      ],
    },
    {
      id: 'us', name: 'Priya & me', kind: 'couple', theme: 'midnight',
      members: [{ id: ME, name: 'Me' }, { id: 'priya', name: 'Priya' }],
      expenses: [
        x('Dinner at Toit', 'food', 4840, ME, [ME, 'priya'], '2026-09-20'),
        x('Movie tickets', 'fun', 960, 'priya', [ME, 'priya'], '2026-09-22'),
      ],
    },
  ] satisfies Group[],
}
