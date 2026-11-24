// ====================================================================
// js/systems/helpbook.js — THE HELP BOOK (v2.101). Replaces the one long list that
// HELP used to show with ten sections of entries and a search box. Every entry says what a thing is,
// where its button is, the steps, the costs and numbers, and a tip or two.
//
// ACCURACY RULES this file is built on:
//   1. No number is typed into the prose. Every figure is rendered through n() / money() / pct(), which read it
//      from the owning module at the moment the book opens (ECON in config.js, each system's exported `rules`,
//      its exported catalogs, or its exported functions) and tag it <b class="hb-n" data-live="Source.key">.
//      A source that is missing or not a finite number makes that entry fail loudly (console.error + a visible
//      "could not be read" stub) instead of showing a made-up value. scripts/helpbook-test.mjs fails if any digit
//      appears outside a data-live tag.
//   2. Button and panel names are the exact strings the code renders (each was grepped), or are read from the DOM
//      (the bottom bar's labels) so they cannot drift.
//   3. Mechanics are what the code does, not what an old comment says (for example the Grid's daily drift is read
//      from PWR.rules, not copied from its header).
// Companies and Stocks entries only appear when the hosted server has enabled companies.
// Additive: wraps nothing. HELP.open() is what openHelp() in render/night.js calls. window.HELP is the QA surface.
// Keeps #hp-gfx (so saveio.js still finds the row to insert EXPORT / IMPORT after), #hp-tut, #hp-x, the OSM
// attribution line, and leaves <div id="hp-academy-slot"> for the guide engine's ACADEMY button.
// ====================================================================
import { ECON, CUISINES, COMMODITIES, GAME_VERSION } from '../config.js';
import { STATE } from '../state.js';
import { fmt$ } from '../util.js';
import { openModal, closeModal } from '../ui/dom.js';

export const HELP = (() => {
  // ---- live readers ---------------------------------------------------------
  const win = k => { const m = window[k]; if (!m) throw new Error('module ' + k + ' is not loaded'); return m; };
  const RU = k => { const m = win(k); if (!m.rules) throw new Error(k + '.rules is missing'); return m.rules; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // n(source, value, format): one number, tagged with where it came from; throws if it is not a finite number
  const n = (src, v, f) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('not a finite number: ' + src + ' = ' + v);
    return '<b class="hb-n" data-live="' + src + '">' + (f ? f(v) : (Math.round(v * 100) / 100).toLocaleString('en-US')) + '</b>';
  };
  const money = (src, v) => n(src, v, x => (Number.isInteger(x) ? fmt$(x) : '$' + x.toFixed(2)));   // whole dollars stay whole; a fractional rate (a $1.50 fee, a $0.25 rate) keeps its cents, never rounded
  const money2 = (src, v) => n(src, v, x => '$' + x.toFixed(2));   // cents kept (menu prices, tips, the grid price)
  const dayz = (src, v) => n(src, v) + (v === 1 ? ' day' : ' days');
  const pct = (src, v) => n(src, v, x => (Math.round(x * 10000) / 100) + '%');   // a 0.25% fee stays 0.25%, never rounds to 0%
  const pct2 = pct;
  const tons = (src, v) => n(src, v, x => x.toLocaleString('en-US') + ' t');
  const secs = (src, v) => n(src, v, x => (Math.round(x * 10) / 10) + ' s');
  const b = s => '<b class="hb-b">' + esc(s) + '</b>';   // a button / panel name exactly as the game shows it
  const mats = o => Object.entries(o).map(([k, t]) => n('mat.' + k, t) + ' t ' + esc(k.toLowerCase())).join(', ');

  // ---- entry layout -----------------------------------------------------------
  // an entry returns { what, where, steps[], nums[[label, html]], tips[] }; every field is optional
  const render = o => {
    let h = '';
    if (o.what) h += '<p class="hb-what">' + o.what + '</p>';
    if (o.where) h += '<div class="hb-k">WHERE</div><p>' + o.where + '</p>';
    if (o.steps && o.steps.length) h += '<div class="hb-k">STEP BY STEP</div><ol>' + o.steps.map(x => '<li>' + x + '</li>').join('') + '</ol>';
    if (o.nums && o.nums.length) h += '<div class="hb-k">COSTS AND NUMBERS</div>' + o.nums.map(([k, v]) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>').join('');
    if (o.tips && o.tips.length) h += '<div class="hb-k">TIPS</div><ul>' + o.tips.map(x => '<li>' + x + '</li>').join('') + '</ul>';
    return h;
  };
  const E = (id, title, keys, fn) => ({ id, title, keys, fn });

  // ---- the bottom bar, read from the page so it can never drift ---------------------
  const BAR_HELP = {
    'WORLD': 'leaves the city for the orbit view of the whole Earth',
    'BUILD': 'the builder: yard, catalog, your own designs, placement',
    'MARKET': 'the Open Exchange: order book, limit and market orders',
    'MINE': 'mining claims, the OFFSHORE rigs row and THE WORKS row',
    'ORE': 'the Ore Exchange: sell the ore and refined goods in your stockpile',
    'RANK': 'the Money List: you against the rival tycoons',
    'POWER': 'the Grid: meters, bills, and your own generators',
    'FIND ME': 'snaps the camera back to your tycoon',
    'HELP': 'this book',
    'BANK': 'accounts, transfers, cards, statements, ledger, loans',
    'COMPANY': 'real-player companies (hosted server only)',
    'STOCKS': 'company stocks (hosted server only, when stocks are on)',
  };
  const barButtons = () => Array.from(document.querySelectorAll('#bb-row .bb-btn .tip')).map(t => t.textContent.trim()).filter(Boolean);

  // ====================================================================
  // THE SECTIONS
  // ====================================================================
  const SECTIONS = [
    // ---------------------------------------------------------------- 1
    {
      id: 'basics', title: 'Basics and controls', entries: [
        E('moving', 'Moving, looking and zooming', 'move walk wasd arrows joystick camera zoom rotate pan find me map search', () => ({
          what: 'You play one tycoon figure on a real map of the Earth. The camera and the tycoon are separate things: you walk the tycoon, and you look with the camera.',
          steps: [
            'Tap or click the ground: your tycoon walks there. That is the only way the tycoon moves.',
            'Glide the view with W A S D, the arrow keys or the on-screen joystick. These move the camera only, not the tycoon.',
            'Rotate with a right-drag (or Ctrl + drag). Zoom with the mouse wheel, or pinch on a touch screen.',
            'Press <b>C</b>, or the ' + b('FIND ME') + ' button, to snap the camera back to your tycoon.',
            'Press <b>M</b>, or click the minimap (bottom right), for the big map.',
            'The magnifier chip at the top opens ' + b('Find My Street') + ': type a street, landmark or city, then ' + b('GO') + '.',
            'The gold pill above the bottom bar, ' + b('WALK TO <CITY>') + ', walks your tycoon to the nearest other city along the roads, around lakes and seas.',
          ],
          tips: ['If the camera has wandered off, the pill’s distance is still your tycoon’s. Press C to bring the view back.'],
        })),
        E('bar', 'The bottom bar and the top right', 'buttons toolbar bar world build market mine ore rank power bank company stocks avatar empire teleport', () => {
          const labels = barButtons();
          if (!labels.length) throw new Error('the bottom bar was not found');
          return {
            what: 'The row of buttons along the bottom opens every system. This list is read from the page itself, so it always matches what you see.',
            where: 'Along the bottom of the screen. ' + b('BANK') + ' is added by the banks system; ' + b('COMPANY') + ' and ' + b('STOCKS') + ' only appear when the hosted server has companies switched on.',
            nums: labels.map(l => ['<b class="hb-b">' + esc(l) + '</b>', esc(BAR_HELP[l] || 'opens its panel')]),
            tips: ['Tap your avatar chip (top right, it shows where you are) to open your empire: every plot, office and holding with a ' + b('TELEPORT') + ' or ' + b('TRAVEL') + ' button.'],
          };
        }),
        E('plots', 'Plots, lots and your first money', 'plot lot buy start money balance sidewalk roadside green parcel', () => ({
          what: 'Land comes in two kinds. A green parcel with a $ marker is a sidewalk or roadside vending spot for a food cart. A parcel with a house icon and a gold dashed border is a building lot, the only city ground that carries buildings.',
          steps: [
            'Walk near a parcel and click it. The panel shows its size, ' + b('PRICE') + ' and your ' + b('BALANCE') + '.',
            'Press ' + b('BUY PLOT') + ' for a vending spot, or ' + b('BUY LOT') + ' for a building lot.',
            'Click the parcel again: a vending spot opens ' + b('Park a Food Cart') + '; a lot lets you put a cart on it and, with ' + b('BUILD') + ', buildings around it.',
          ],
          nums: [['A new game starts with', money('ECON.startMoney', ECON.startMoney)], ['Money is play money', 'there is no real-money feature, ever']],
          tips: ['Every parcel shows its own price in its panel. Look at it before you press the button.'],
        })),
        E('worth', 'Net worth, the ticker and saving', 'worth net rank ticker save localstorage', () => ({
          what: 'The WORTH figure in the ticker is your net worth. The Money List ranks you against the rival tycoons by this same figure.',
          nums: [['Counts', 'cash and what you own, plus bank balances'], ['Subtracts', 'what you owe on cards and loans'], ['Away time', 'the Night Shift settles up to ' + n('NIGHT.CAP_HOURS', RU('NIGHT').CAP_HOURS) + ' hours of income when you come back']],
          tips: ['The game saves in your browser as you play. See the last section for exporting a save file.'],
        })),
      ],
    },
    // ---------------------------------------------------------------- 2
    {
      id: 'carts', title: 'Carts and vendors', entries: [
        E('park', 'Parking a food cart', 'cart cuisine park permit food hot dog taco sushi burger pizza', () => {
          const R = RU('ECO'), first = !(STATE.plots.some(p => p.cart));
          return {
            what: 'A food cart on one of your plots sells to a queue of customers. It is the game’s first income.',
            where: 'Click a plot you own that has no cart: the ' + b('Park a Food Cart') + ' window opens.',
            steps: ['Choose a cuisine tile. Each tile shows what the cart will cost you.', 'The cart appears at once and customers start lining up.', 'Click the cart any time to manage it (menu, crew, power, scrap).'],
            nums: [['Cart', money('ECON.cartCost', ECON.cartCost)], ['Permit (your first cart only)', money('ECON.permitCost', ECON.permitCost)],
              ['Cuisines', CUISINES.map(c => esc(c.emoji + ' ' + c.name)).join(' · ')], ['Scrap a cart for', money('ECO.rules.SCRAP_BACK', R.SCRAP_BACK)]],
            tips: ['The panel also has ' + b('RENT OUT THE LAND — SET YOUR PRICE'), 'A plot that is on the rental market must be taken off it before a cart can go there.'],
          };
        }),
        E('serve', 'Serving customers', 'serve customers queue patience tip e key line', () => {
          const R = RU('ECO');
          return {
            what: 'Customers arrive at your cart on their own and queue. Each one buys one menu item and leaves a small tip. You can serve them yourself or let vendors do it.',
            where: 'Stand next to your cart. A bar appears ("in line at your cart") with ' + b('SERVE  [E]') + '.',
            steps: ['Walk your tycoon to within reach of the cart.', 'Press <b>E</b> or the ' + b('SERVE') + ' button to serve the customer at the front of the line.', 'Watch the patience counter: a customer who waits too long walks away.'],
            nums: [['A customer arrives every', n('ECON.custSpawnMin', ECON.custSpawnMin) + ' to ' + secs('ECON.custSpawnMax', ECON.custSpawnMax)], ['Patience', secs('ECON.custPatience', ECON.custPatience)],
              ['Tip on each sale', money2('ECON.serveTipMin', ECON.serveTipMin) + ' to ' + money2('ECON.serveTipMax', ECON.serveTipMax)], ['Reach of the serve button', n('ECO.rules.SERVE_REACH', R.SERVE_REACH) + ' m']],
            tips: ['A cart whose power is cut serves nobody. See the Power section.'],
          };
        }),
        E('menu', 'The cart panel: menu, appeal and live income', 'menu appeal kpi p&l revenue business panel', () => ({
          what: 'Click your cart to open its ' + b('Business') + ' window: live income, the menu, the crew and the power meter.',
          steps: ['The top line is the live P&L per minute.', 'The four boxes are ' + b('REV / MIN') + ', ' + b('CUSTOMERS') + ', ' + b('CREW') + ' and ' + b('APPEAL') + '.', 'The menu table lists every item with its price and an appeal bar.'],
          nums: CUISINES.map(c => {
            const ps = c.menu.map(m => m[1]), mn = Math.min(...ps), mx = Math.max(...ps);
            return [esc(c.emoji + ' ' + c.name), 'items ' + money2('CUISINE.' + c.id + '.min', mn) + ' to ' + money2('CUISINE.' + c.id + '.max', mx)];
          }),
          tips: ['Items with a higher appeal are picked more often: the menu is a weighted draw.', 'Tips are added to the item price on every sale.'],
        })),
        E('vendors', 'Hiring vendors', 'vendor hire fire stars crew serve speed wage', () => {
          const R = RU('ECO'), E2 = win('ECO');
          return {
            what: 'A vendor stands behind your cart and serves the front customer by themselves while you are busy or away from the cart. More stars serve faster.',
            where: 'The ' + b('Crew') + ' section of the cart panel: empty slots show the next candidate, their stars and a ' + b('HIRE') + ' button. ' + b('FIRE') + ' lets a vendor go.',
            steps: ['Open the cart panel.', 'Pick an empty slot and read the candidate’s stars and the hire price.', 'Press ' + b('HIRE') + '. The vendor starts serving.'],
            nums: [['Slots per cart', n('ECO.rules.MAX_CREW', R.MAX_CREW)]].concat([1, 2, 3, 4, 5].map(s => [n('stars', s) + ' ★', 'hire fee ' + money('ECO.hireFee(' + s + ')', E2.hireFee(s)) + ' · serves every ' + secs('ECO.rules.vendorEvery(' + s + ')', R.vendorEvery(s))])),
            tips: ['Hiring is a one-time fee. The game has no wage for cart vendors.', 'The candidate in a slot is fixed for that plot and slot, so re-opening the panel does not reroll them.', 'Vendors keep a staffed cart earning while you are away (the Night Shift). An unstaffed cart earns nothing while you are away.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 3
    {
      id: 'land', title: 'Land, offices and landlord', entries: [
        E('offices', 'Leasing an office suite', 'office suite lease rent tower deposit', () => {
          const R = RU('ECO');
          return {
            what: 'A suite in a city tower pays you its rent every game day. You do not need to be there.',
            where: 'Hover a building in a city: a tooltip says "Available to rent" for the ones that have a suite. Click it to open its lease window.',
            steps: ['Read the size and the ' + b('RENT') + ' per day.', 'Press ' + b('LEASE SUITE') + '. The deposit is taken at once.', 'Click the tower again to manage it: ' + b('RENT IT OUT — SET YOUR PRICE') + ' or ' + b('END LEASE') + '.'],
            nums: [['Deposit', n('ECO.rules.OFFICE_DEPOSIT_DAYS', R.OFFICE_DEPOSIT_DAYS) + ' days of rent, not refundable'], ['Most suites you can lease', n('ECO.rules.OFFICE_CAP', R.OFFICE_CAP)], ['A game day lasts', n('BANK.DAY', win('BANK').DAY) + ' seconds of play']],
          };
        }),
        E('deeds', 'Buying or renting a floor or a room', 'floor room buy rent deed property title deed inspector', () => {
          const R = RU('PROP');
          return {
            what: 'Any floor of a big building, or any room of a house or small shop, can be bought or rented.',
            where: 'Click a building or a house, pick a floor or a room in the panel, and read the deal block under the list.',
            steps: ['Pick the floor or room.', 'Press ' + b('BUY') + ' (yours to keep) or ' + b('RENT') + ' (a deposit, then it pays its rent each game day).', 'Manage it later with ' + b('MANAGE PROPERTY') + ' or ' + b('MANAGE LEASE') + ', or from your empire list.'],
            nums: [['Buy price', n('PROP.BUY_MULT', R.BUY_MULT) + ' days of the unit’s rent'], ['A bought unit earns', n('PROP.OWN_YIELD', R.OWN_YIELD) + ' times its rent per day'], ['Rent deposit', n('PROP.DEPOSIT', R.DEPOSIT) + ' days of rent, not refundable'],
              ['Sell a bought unit for', pct('PROP.SELL_BACK', R.SELL_BACK) + ' of its price'], ['Most units you can hold', n('PROP.CAP', R.CAP)]],
            tips: ['Prices come from the building itself, so the deal you saw yesterday is the deal you see today.', 'A unit can hold machines (' + b('INSTALL MACHINES') + ') and furniture (' + b('FURNISH — THE FURNITURE SHOP') + ').'],
          };
        }),
        E('landlord', 'Being a landlord', 'landlord rent out sublet tenant price lease evict vacant', () => {
          const R = RU('LORD');
          return {
            what: 'Anything you hold can be put on the rental market at a price you choose: an empty plot, an office suite, a floor or room, a farm.',
            where: b('RENT OUT THE LAND — SET YOUR PRICE') + ' on an empty plot, ' + b('RENT IT OUT — SET YOUR PRICE') + ' on an office or a bought unit, ' + b('SUBLET IT — SET YOUR PRICE') + ' on a rented one, ' + b('RENT OUT THE FARM — SET YOUR PRICE') + ' on a farm.',
            steps: ['Open the rent-out window. It shows the market rate and an outlook line.', 'Type a price, or use ' + b('MARKET') + ', ' + b('+10%') + ' and ' + b('−10%') + '.', 'Confirm. The unit’s own income stops while it is listed; a tenant pays your price once one signs.', 'Later: ' + b('TAKE OFF MARKET') + ', or ' + b('EVICT — RELIST AT MY PRICE') + '.'],
            nums: [['Lease length', n('LORD.LEASE_MIN', R.LEASE_MIN) + ' to ' + n('LORD.LEASE_MAX', R.LEASE_MAX) + ' game days'],
              ['Chance a viewer signs, at market price', pct('LORD.takeProb(1)', R.takeProb(1))], ['at double the market price', pct('LORD.takeProb(2)', R.takeProb(2))], ['at triple the market price', pct('LORD.takeProb(3)', R.takeProb(3))]],
            tips: ['Overpricing means long empty stretches earning nothing. That is the gamble.', 'The outlook line calls the demand before you commit.', 'Your listings are all in the empire panel.'],
          };
        }),
        E('farm', 'Farmland acres', 'farm acre field parcel patchwork land buy hedge', () => {
          const R = RU('FARM');
          return {
            what: 'Past every city’s suburbs the countryside is a patchwork of fields of every size. Each one can be bought, and pays tenant rent every game day.',
            where: 'Zoom out until the fields turn into a land catalog (about ' + n('FARM.SHOP_DIST', R.SHOP_DIST) + ' m up), hover a field for its size and price, and click it. At street level every field has a small FOR SALE sign to click instead.',
            steps: ['Click a field.', 'Press the ' + b('BUY') + ' button in its panel (it names the field).', 'The hedge border turns gold. Manage it later with ' + b('SELL') + ', ' + b('TELEPORT') + ' or ' + b('RENT OUT THE FARM — SET YOUR PRICE') + '.'],
            nums: [['Sell back at', pct('FARM.SELL_BACK', R.SELL_BACK)], ['Most acres you can hold', n('FARM.CAP', R.CAP)]],
            tips: ['Fields never sit inside a city or its suburb ring, and never in water.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 4
    {
      id: 'build', title: 'Building, factories and furniture', entries: [
        E('builder', 'Raising a building', 'build builder yard catalog house shop apartment factory materials wood stone steel glass demolish place', () => {
          const B = win('BLD'), R = RU('BLD'), Y = B.YARD;
          return {
            what: 'The builder turns a lot of yours into houses, shops, apartment blocks and factory shells. A building takes game days to rise, then pays income every day.',
            where: 'The ' + b('BUILD') + ' button in the bottom bar (you must be in the world, not in the orbit view).',
            steps: ['Press ' + b('BUILD') + ' and pick a type in the catalog.', 'Stock the materials: wood and stone come from the ' + b('YARD') + '; steel and glass come from the yard or from your Ore Exchange stockpile first. ' + b('BUY MISSING') + ' buys whatever is short.', 'Press ' + b('PLACE ▸') + ': a one-metre grid overlays your plot and a ghost follows the cursor. Click to site it.', 'Click a finished building to open it: ' + b('DEMOLISH') + ' refunds part of its materials.'],
            nums: B.TYPES.map(T => ['<b class="hb-b">' + esc(T.icon + ' ' + T.name) + '</b>', dayz('BLD.' + T.id + '.days', T.days) + ' · ' + money('BLD.' + T.id + '.inc', T.inc) + '/day · worth ' + money('BLD.' + T.id + '.val', T.val) + '<br><small>' + mats(T.mat) + '</small>'])
              .concat([['The yard sells per tonne', Object.keys(Y).map(k => esc(k) + ' ' + money('BLD.YARD.' + k, Y[k])).join(' · ')], ['Buildings per plot, at most', n('BLD.MAX_PER_PLOT', B.MAX_PER_PLOT)], ['Demolish refunds', pct('BLD.rules.SCRAP', R.SCRAP) + ' of the materials']]),
            tips: ['Steel and glass from your own Works land in the same Ore Exchange pile the builder draws from first, so refining can save yard money.'],
          };
        }),
        E('architect', 'Design your own building', 'architect design own style floors width depth custom studio', () => {
          const R = RU('BLD'), S = R.STUDIO, D = R.designOf(10, 8, 3, 'brick', '');
          return {
            what: 'The Architect composes a building only you would draw. Cost, build time and income all scale with its size: a tall landmark is a big project.',
            where: b('✏️ DESIGN YOUR OWN BUILDING') + ' in the builder catalog.',
            steps: ['Use the − and + buttons for ' + b('WIDTH') + ', ' + b('DEPTH') + ' and ' + b('FLOORS') + '.', 'Pick a ' + b('STYLE') + ' chip and type a ' + b('NAME') + '.', 'Read the draft, ' + b('MATERIALS') + ', ' + b('COST AT THE YARD') + ' and ' + b('BUILDS & PAYS') + ' lines.', 'Press ' + b('SAVE TO CATALOG') + ', then ' + b('PLACE ▸') + ' it like any building.'],
            nums: [['Width', n('BLD.STUDIO.W.0', S.W[0]) + ' to ' + n('BLD.STUDIO.W.1', S.W[1]) + ' m'], ['Depth', n('BLD.STUDIO.D.0', S.D[0]) + ' to ' + n('BLD.STUDIO.D.1', S.D[1]) + ' m'], ['Floors', n('BLD.STUDIO.FLOORS.0', S.FLOORS[0]) + ' to ' + n('BLD.STUDIO.FLOORS.1', S.FLOORS[1])],
              ['Styles', R.STYLES.map(s => esc(s.icon + ' ' + s.name)).join(' · ')], ['Designs you can keep', n('BLD.STUDIO.MAX_DESIGNS', S.MAX_DESIGNS)],
              ['Example: a ' + n('example.w', D.w) + ' by ' + n('example.d', D.d) + ' m, ' + n('example.floors', D.floors) + '-floor brick walk-up', dayz('example.days', D.days) + ' · ' + money('example.inc', D.inc) + '/day · worth ' + money('example.val', D.val) + '<br><small>' + mats(D.mat) + '</small>']],
            tips: [b('REMOVE') + ' takes a design out of the catalog, but only while none of your buildings still stand from it.'],
          };
        }),
        E('factory', 'Factory floors', 'factory machines cnc press assembly weld molder heavy industry shell install', () => {
          const F = win('FACT'), FR = RU('FACT');
          return {
            what: 'A finished factory shell has a floor you can fill with working machines. Each one pays income every game day.',
            where: 'Click a finished factory shell, then press ' + b('MACHINES') + '.',
            steps: ['Open ' + b('FACTORY FLOOR') + '.', 'Pick a machine and press ' + b('INSTALL') + ', then click the floor to set it down (the shell fades to a cutaway while you place).', 'Sell any machine back from the installed list.'],
            nums: [['Machines on one floor, at most', n('FACT.CAP()', F.CAP())], ['Sell back at', pct('FACT.rules.SELL_BACK', FR.SELL_BACK)]]
              .concat(F.FTYPES.map(T => ['<b class="hb-b">' + esc(T.name) + '</b> (heavy)', money('FACT.' + T.key + '.cost', T.cost) + ' · +' + money('FACT.' + T.key + '.inc', T.inc) + '/day']))
              .concat(win('MACH').TYPES.map(T => ['<b class="hb-b">' + esc(T.name) + '</b> (classic)', money('MACH.' + T.key + '.cost', T.cost) + ' · +' + money('MACH.' + T.key + '.inc', T.inc) + '/day'])),
            tips: ['The classic machines also work on any floor you own or rent (see the next entry).'],
          };
        }),
        E('machines', 'Machines in rooms and floors', 'machine vending arcade laundry coffee printer server rack install room floor', () => {
          const M = win('MACH'), R = RU('MACH');
          return {
            what: 'Any room or floor you own or rent can hold machines. Each pays income every game day and counts in your worth.',
            where: 'In the deal block of a unit you hold, or in its ' + b('MANAGE PROPERTY') + ' window: ' + b('INSTALL MACHINES') + ' (or ' + b('MANAGE MACHINES') + ' once you have some).',
            steps: ['Open the ' + b('MACHINES') + ' window for the unit.', 'Pick a machine, press ' + b('INSTALL') + ', then click a spot inside your space.', 'Keep clicking to fill the space; ESC or DONE ends placing. Sell a machine from the list.'],
            nums: [['One machine per', n('MACH.AREA_PER', R.AREA_PER) + ' m² of space, up to ' + n('MACH.CAP_MAX', R.CAP_MAX)], ['Sell back at', pct('MACH.SELL_BACK', R.SELL_BACK)]]
              .concat(M.TYPES.map(T => ['<b class="hb-b">' + esc(T.name) + '</b>', money('MACH.' + T.key + '.cost', T.cost) + ' · +' + money('MACH.' + T.key + '.inc', T.inc) + '/day'])),
            tips: ['Machine income is separate from rent. Putting a unit on the rental market does not touch it.'],
          };
        }),
        E('furniture', 'Furnishing a room', 'furniture bed chair table sofa lamp desk computer craft buy rotate', () => {
          const F = win('FURN'), R = RU('FURN');
          return {
            what: 'Furnish the rooms and floors you own or rent. Furniture is comfort, not income, but it counts in your worth at catalog price.',
            where: b('FURNISH — THE FURNITURE SHOP') + ' in the deal block of a unit you hold, or ' + b('FURNISH') + ' in its ' + b('MANAGE PROPERTY') + ' window.',
            steps: ['Pick a piece and press ' + b('BUY') + ' (cash) or ' + b('CRAFT') + ' (from the materials in your shed).', 'A ghost follows the cursor: green where it fits, red where it does not. Press <b>R</b> (or the ↻ button) to turn it, click to set it down.', 'Keep clicking to fill the room. ' + b('DONE') + ' or ESC ends placing.', 'Click a placed piece for ' + b('ROTATE ↻ 90°') + ', ' + b('MOVE') + ' or ' + b('SELL') + '.'],
            nums: [['Pieces per space', 'one per ' + n('FURN.AREA_PER', R.AREA_PER) + ' m², at least ' + n('FURN.CAP_MIN', R.CAP_MIN) + ', at most ' + n('FURN.CAP_MAX', R.CAP_MAX)], ['Selling a piece returns', pct('FURN.SELL_BACK', R.SELL_BACK)]]
              .concat(F.TYPES.map(T => ['<b class="hb-b">' + esc(T.icon + ' ' + T.name) + '</b>', money('FURN.' + T.key + '.price', T.price) + ' cash, or craft from ' + mats(T.mat)])),
            tips: ['A computer sits on a desk: place the desk first. A desk cannot move or be sold while a computer is on it.', 'Crafting is the cheap way: the same tonnes the yard sells.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 5
    {
      id: 'mining', title: 'Mining, offshore rigs, the Ore Exchange and the Works', entries: [
        E('claims', 'Staking a mining claim', 'mine mining claim stake ore crew wage machinery loader excavator dig', () => {
          const R = RU('MINE'), M = win('MINE');
          return {
            what: 'A claim is a rectangle of open country that holds a fixed amount of one ore. Machinery and a crew dig it out, and the ore lands in your stockpile to sell on the Ore Exchange.',
            where: 'The ' + b('MINE') + ' button, then ' + b('STAKE A CLAIM — SELECT AN AREA') + '.',
            steps: ['Click the first corner, then the second, of a rectangle of open country. The panel shows the assay (ore and grade), the reserve and the ' + b('CLAIM PRICE') + '.', 'Press ' + b('STAKE THE CLAIM') + '. The ' + b('MACHINERY & CREW') + ' window opens (later: ' + b('MINE') + ', ' + b('MANAGE') + ', then ' + b('MACHINERY & CREW') + ' or ' + b('BUY MACHINERY & HIRE A CREW') + ').', 'Buy machinery with ' + b('INSTALL') + ' and click spots on the claim’s dirt ring to set each machine down (ESC or DONE to finish).', 'Hire operators with ' + b('+ HIRE 1') + ', ' + b('+ HIRE 5') + ' or ' + b('FULL CREW') + '. ' + b('LAY OFF ALL') + ' stops the wages.'],
            nums: [['Claim size', n('MINE.MIN_SIDE', R.MIN_SIDE) + ' to ' + n('MINE.MAX_SIDE', R.MAX_SIDE) + ' m a side, corners snap to ' + n('MINE.SNAP', R.SNAP) + ' m'], ['Claim price', money('MINE.CLAIM_RATE', R.CLAIM_RATE) + ' per m²'], ['Ore in the ground', n('MINE.DENS', R.DENS) + ' tonnes per m²'],
              ['Wage', money('MINE.WAGE', R.WAGE) + ' per worker per game day'], ['Most workers per claim', n('MINE.MAX_CREW', R.MAX_CREW)], ['Most claims', n('MINE.MAX_MINES', R.MAX_MINES)], ['Machinery sells back at', pct('MINE.SELL_BACK', R.SELL_BACK)],
              ['Ore types', Object.keys(M.BASE).map(k => esc(k) + ' (par ' + money('MINE.BASE.' + k, M.BASE[k]) + '/t)').join(' · ')]]
              .concat(M.TYPES.map(T => ['<b class="hb-b">' + esc(T.name) + '</b>', money('MINE.' + T.key + '.cost', T.cost) + ' · digs ' + tons('MINE.' + T.key + '.tpd', T.tpd) + '/day with ' + n('MINE.' + T.key + '.ops', T.ops) + ' operator' + (T.ops === 1 ? '' : 's')])),
            tips: ['A crew that is too short digs proportionally slower: people dig, not steel.', 'A claim never sits near a city, on water, on a road, on a plot or farm, or on another claim. The panel says which rule stopped you.', 'When the ore runs out the crew is released.'],
          };
        }),
        E('ore', 'The Ore Exchange', 'ore exchange sell stockpile price par iron copper coal silver', () => {
          const E2 = win('EXCH'), R = RU('EXCH');
          return {
            what: 'Everything your mines dig, and everything your works pour, goes into one stockpile. The Ore Exchange sells it at today’s price.',
            where: 'The ' + b('ORE') + ' button.',
            steps: ['Rows you hold glow gold. Each row shows today’s price and its change since yesterday.', 'Press ' + b('SELL HALF') + ' or ' + b('SELL ALL') + ' on a row, or ' + b('SELL EVERYTHING') + ' at the top.', 'The button ' + b('THE WORKS') + ' opens the refining machines.'],
            nums: [['Price today', 'par times a multiplier'], ['Multiplier band', n('EXCH.LO', R.LO) + ' to ' + n('EXCH.HI', R.HI)], ['Daily move, at most', pct('EXCH.STEP/2', R.STEP / 2) + ' up or down'], ['Resources listed now', n('EXCH.list', E2.list().length)]],
            tips: ['Wages are paid in cash every day, so hoarding the whole pile can still cost you the crew.', 'The pile counts in your net worth at today’s prices.'],
          };
        }),
        E('works', 'The Works: refining', 'works refine refinery smelter furnace kiln steel cathode goods', () => {
          const W = win('WORKS'), R = RU('WORKS');
          return {
            what: 'Refining machines turn ore from your stockpile into refined goods, which usually trade for more than the ore that went in.',
            where: b('THE WORKS') + ' on the Ore Exchange board, or the ' + b('THE WORKS') + ' row on the ' + b('MINE') + ' panel (press ' + b('OPEN') + ').',
            steps: ['Pick a machine and press ' + b('BUY') + '. You can own several of a kind.', 'Every game day each machine draws ore from the stockpile and pours goods back into it. A short pile runs the line slower.', 'Sell the goods on the Ore Exchange. ' + b('SCRAP') + ' sells a machine back.'],
            nums: [['Power cost', money('WORKS.POWER', R.POWER) + ' per tonne processed'], ['Scrap value', pct('WORKS.SELL_BACK', R.SELL_BACK)]]
              .concat(W.list().map(T => ['<b class="hb-b">' + esc(T.name) + '</b>', money('WORKS.' + T.id + '.cost', T.cost) + ' · ' + tons('WORKS.' + T.id + '.tpd', T.tpd) + ' ' + esc(T.in.toLowerCase()) + '/day → ' + esc(T.out) + ' (' + n('WORKS.' + T.id + '.n', T.n) + ' t in per t out) · par ' + money('WORKS.' + T.id + '.par', T.par) + '/t'])),
            tips: ['Steel and glass you refine sit in the same stockpile the builder draws from.'],
          };
        }),
        E('rigs', 'Offshore oil rigs', 'oil rig offshore crude pump tank offload ocean crew pressure', () => {
          const R = RU('OIL'), O = win('OIL');
          return {
            what: 'The ocean is an oil field. A rig stands on open water, a crew pumps crude into its own tank, and you offload it to the Ore Exchange.',
            where: 'The ' + b('MINE') + ' button, the ' + b('OFFSHORE') + ' row, ' + b('OPEN') + ', then ' + b('BUILD A RIG — PICK AN OFFSHORE SPOT') + '.',
            steps: ['Click open water that is clear of coasts and your other rigs. The panel shows the bill: ' + b('BUILD THE RIG') + ' (' + b('BUY MISSING') + ' buys any materials you lack).', 'Open the rig with ' + b('MANAGE') + ' and hire a crew: ' + b('+ HIRE 1') + ', ' + b('+ HIRE 5') + ', ' + b('FULL CREW') + '.', 'Crude fills the tank. ' + b('OFFLOAD TANK') + ' moves it to your stockpile for the freight, then ' + b('SELL CRUDE ON THE ORE EXCHANGE') + '.', b('DECOMMISSION') + ' salvages the rig.'],
            nums: [['Rig', money('OIL.PRICE', R.PRICE) + ' plus ' + mats(O.BILL)], ['Most rigs', n('OIL.MAX_RIGS', R.MAX_RIGS)], ['Clear water to any coast', n('OIL.SHORE_CLR', R.SHORE_CLR) + ' m'], ['Water between two of your rigs', n('OIL.MIN_GAP', R.MIN_GAP) + ' m'],
              ['Full crew', n('OIL.FULL_CREW', O.FULL_CREW) + ' workers'], ['Output at full crew and full pressure', tons('OIL.BASE_TPD', R.BASE_TPD) + '/day'], ['Tank', tons('OIL.CAP', O.CAP)], ['Wage', money('OIL.WAGE', O.WAGE) + ' per worker per day'],
              ['Marine upkeep while a crew is aboard', money('OIL.UPKEEP', O.UPKEEP) + '/day'], ['Freight to offload', money('OIL.FREIGHT', O.FREIGHT) + '/t'], ['Crude par price', money('OIL.PAR', O.PAR) + '/t'], ['Decommission salvage', pct('OIL.SELL_BACK', R.SELL_BACK)]],
            tips: ['Pressure falls as the field drains, so the pump rate drops over time.', 'A short crew pumps slower. A full tank lays the crew up.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 6
    {
      id: 'market', title: 'Market and trading', entries: [
        E('exchange', 'The Open Exchange: market and limit orders', 'market exchange trade limit order book buy sell escrow fee tape position', () => {
          const R = RU('MARKET');
          return {
            what: 'A live order book for a list of commodities. A crowd of market-makers works the desk between you and the reserve.',
            where: 'The ' + b('MARKET') + ' button in the bottom bar.',
            steps: ['Pick a commodity in the quote card (' + COMMODITIES.map(c => esc(c.sym + ' ' + c.name)).join(', ') + ').', 'Open the ' + b('LIMIT') + ' tab for a price you name, or the ' + b('MARKET') + ' tab to trade at once at whatever the book offers.', 'Limit: enter ' + b('Price $') + ' and ' + b('Qty') + ', then ' + b('BUY') + ' or ' + b('SELL') + '. The order rests until the book reaches it.', 'Market: enter ' + b('Qty (market)') + ' and press ' + b('BUY') + ' or ' + b('SELL') + '. It fills now by taking whatever the book offers; anything beyond the book fills at a worse price.', 'Resting orders list under ' + b('Open Orders') + '; cancel to get the escrow back.'],
            nums: [['Fee', pct('MARKET.FEE', R.FEE) + ' of every fill'], ['A resting limit buy', 'holds its full cost plus the fee until it fills or you cancel'], ['A resting limit sell', 'holds the goods out of your position until it fills or you cancel']],
            tips: ['A limit order waits for your price; a market order never waits. Cancel a resting order any time to get its escrow back.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 7
    {
      id: 'power', title: 'Power and generators', entries: [
        E('grid', 'The Grid: meters, bills and cut-offs', 'power grid meter bill kwh electricity cut reconnect pay price', () => {
          const R = RU('PWR'), P = win('PWR');
          return {
            what: 'Every cart you run draws electricity. Each game day the meter times the grid price comes due. A bill you cannot pay cuts that business off until you pay.',
            where: 'The ' + b('POWER') + ' button opens the Grid; each cart panel also has its own meter block.',
            steps: ['Open ' + b('POWER') + ': today’s price with its change, and one row per business (draw, estimated bill, ON or CUT).', 'Press the ' + b('PAY') + ' button on a row, or ' + b('PAY ALL BILLS') + ' at the top.', 'On a cut business press ' + b('PAY & RECONNECT') + ' in its cart panel.'],
            nums: [['Grid price par', money2('PWR.PAR', P.PAR) + ' per kWh'], ['Price band', n('PWR.LO', R.LO) + ' to ' + n('PWR.HI', R.HI) + ' times par'], ['Daily drift, at most', pct('PWR.STEP/2', R.STEP / 2) + ' up or down'], ['Draw of one cart', n('PWR.BASE_KW', R.BASE_KW) + ' kW, plus ' + n('PWR.VEND_KW', R.VEND_KW) + ' kW per vendor']],
            tips: ['A cut-off cart has no customers and no sales until you pay.', 'The price spikes and dips: the change arrows on the panel show which way it moved.'],
          };
        }),
        E('generators', 'Building your own power', 'generator solar wind hydro coal oil burner own power blackout surplus capacity', () => {
          const G = win('GEN'), R = RU('GEN');
          return {
            what: 'Your own generators feed your businesses first. Power you generate is not metered, so it is not billed. Spare output can be sold to the grid.',
            where: 'The ' + b('POWER') + ' panel, the ' + b('Own power — generators') + ' section.',
            steps: ['Press a build button (it shows type, rated kW and price). Click a site that suits the type.', 'Open a unit with a click for ' + b('SWITCH ON') + ' / ' + b('SWITCH OFF') + ' and ' + b('DEMOLISH') + '.', 'Press ' + b('SELL SURPLUS') + ' to sell unused output to the grid or keep it off.'],
            nums: R.ORDER.map(k => G.TYPES[k]).map(T => ['<b class="hb-b">' + esc(T.emoji + ' ' + T.name) + '</b>', n('GEN.' + T.name + '.kw', T.kw) + ' kW · ' + money('GEN.' + T.name + '.cost', T.cost) + ' · upkeep ' + money('GEN.' + T.name + '.up', T.up) + '/day<br><small>' + esc(T.hint) + '</small>'])
              .concat([['Most units', n('GEN.MAX_UNITS', G.MAX_UNITS)], ['Demolish salvage', pct('GEN.SELL_BACK', R.SELL_BACK)], ['Burners buy missing fuel at', pct('GEN.SPOT', R.SPOT) + ' of the market price']]),
            tips: ['Renewables first, then burners fill the gap. A burner that cannot pay for fuel goes dark.', 'The utility sometimes fails for a few hours (a banner says so). While it is down, businesses your units cannot cover lose power, then return by themselves when supply returns.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 8
    {
      id: 'banks', title: 'Banks, cards and loans', entries: [
        E('accounts', 'Bank accounts and transfers', 'bank account deposit withdraw transfer ledger statement interest', () => {
          const B = win('BANK'), R = RU('BANK');
          return {
            what: 'Every city has a bank. You may hold one account in each. Money in an account stays in your net worth.',
            where: 'The ' + b('BANK') + ' button. Tabs: ' + b('ACCOUNTS') + ', ' + b('TRANSFER') + ', ' + b('CARDS') + ', ' + b('LOANS') + ', ' + b('STATEMENTS') + ', ' + b('LEDGER') + '.',
            steps: ['In ' + b('Open an account') + ' choose a city bank and press ' + b('OPEN') + '.', 'Type an amount and press ' + b('DEPOSIT') + ' or ' + b('WITHDRAW') + '.', 'In ' + b('TRANSFER') + ' move money between your own accounts in different cities.'],
            nums: [['Transfer between banks', money('BANK.XFER_FEE', B.XFER_FEE) + ' flat fee'], ['A game month is', n('BANK.MONTH', B.MONTH) + ' game days'], ['Interest on balances', pct2('BANK.INT_M', R.INT_M) + ' a month'], ['Ledger keeps the newest', n('BANK.LEDGER_MAX', R.LEDGER_MAX) + ' entries']],
            tips: ['Everything is local to you. There are no transfers to other players.'],
          };
        }),
        E('cards', 'Debit and credit cards', 'card debit credit limit pay with statement minimum late fee interest', () => {
          const R = RU('BANK');
          return {
            what: 'Each account can have a debit card (spends from the account) and a credit card (spends up to a limit, owed on the card).',
            where: 'The ' + b('CARDS') + ' tab. ' + b('GET DEBIT CARD') + ', or ' + b('APPLY') + ' for a credit card. ' + b('Pay with') + ' chooses cash, a debit card or a credit card.',
            steps: ['Issue a card on an account.', 'Under ' + b('Pay with') + ' pick the card the game should use.', 'Pay a credit card with ' + b('PAY FROM ACCOUNT') + ' or ' + b('PAY IN CASH') + '.'],
            nums: [['Statement closes every', n('BANK.MONTH', win('BANK').MONTH) + ' game days'], ['Minimum due', pct('BANK.MIN_PCT', R.MIN_PCT) + ' or ' + money('BANK.MIN_FLOOR', R.MIN_FLOOR) + ', due ' + n('BANK.DUE_GAP', R.DUE_GAP) + ' days later'], ['Late fee on a missed minimum', money('BANK.LATE_FEE', R.LATE_FEE)], ['Interest on an unpaid balance', pct2('BANK.CC_INT_M', R.CC_INT_M) + ' a month'],
              ['Credit limit', 'base ' + money('BANK.LIM_BASE', R.LIM_BASE) + ' plus ' + pct('BANK.LIM_BAL', R.LIM_BAL) + ' of the account balance, between ' + money('BANK.LIM_MIN', R.LIM_MIN) + ' and ' + money('BANK.LIM_MAX', R.LIM_MAX) + ', scaled by your credit score']],
            tips: ['Plots, carts, builds, machines, generators and the other purchases the game makes at its checkout use the chosen card. Wages and utility bills still come out of cash.', 'If the chosen card cannot cover a purchase, the game pays in cash instead.'],
          };
        }),
        E('loans', 'Loans and your credit score', 'loan borrow apr score credit autopay seizure grace', () => {
          const L = win('LOAN'), R = RU('LOAN');
          return {
            what: 'Borrow from a city bank, repay on a schedule, and keep an eye on your credit score.',
            where: 'The ' + b('BANK') + ' button, ' + b('LOANS') + ' tab.',
            steps: ['Choose the account to receive the money, an amount and a term, then press ' + b('TAKE LOAN') + '.', 'A minimum payment is due on a fixed rhythm. ' + b('PAY') + ', ' + b('PAY MINIMUM') + ' or pay it off; autopay can pay the minimum for you.', 'The dashboard shows ' + b('YOUR RATE') + ', ' + b('YOU MAY OWE') + ', ' + b('NEXT DUE') + ' and the repayment schedule.'],
            nums: [['Amount', money('LOAN.MIN_AMT', R.MIN_AMT) + ' to ' + money('LOAN.MAX_AMT', R.MAX_AMT)], ['Terms', L.TERMS.map(t => n('LOAN.TERMS', t)).join(', ') + ' game days'], ['Minimum payment every', n('LOAN.X', L.X) + ' game days'], ['Loans at once', n('LOAN.MAX_LOANS', L.MAX_LOANS)], ['Lowest score that can borrow', n('LOAN.MIN_SCORE', R.MIN_SCORE)],
              ['Your score now / the rate it earns', n('LOAN.score()', L.score()) + ' / ' + pct2('LOAN.aprFor(score)', L.aprFor(L.score()))], ['Grace after a missed payment', n('LOAN.GRACE', L.GRACE) + ' days'], ['Late fee', pct('LOAN.FEE_PCT', R.FEE_PCT) + ' of the minimum, at least ' + money('LOAN.FEE_MIN', R.FEE_MIN)],
              ['Credit drop', n('LOAN.DROP1', R.DROP1) + ' points, then ' + n('LOAN.DROP_N', R.DROP_N) + ' more every ' + n('LOAN.X', L.X) + ' days'], ['Bank accounts seized', n('LOAN.SEIZE_BANK', R.SEIZE_BANK) + ' days after the first missed due day'], ['Properties seized', n('LOAN.SEIZE_PROP', R.SEIZE_PROP) + ' days after the first missed due day']],
            tips: ['Loan time only runs while you play. Nothing accrues and no penalty applies while you are away.', 'Paying what is overdue at any point ends the problem.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 9
    {
      id: 'rank', title: 'Rivals and the Money List', entries: [
        E('moneylist', 'The Money List', 'rank rivals money list leaderboard worth tycoon', () => {
          const R = win('RIVALS');
          return {
            what: 'A fixed cast of rival tycoons around the Earth grow their fortunes every game day. You are ranked among them by net worth.',
            where: 'The ' + b('RANK') + ' button, or ' + b('VIEW LIST') + ' in your empire panel.',
            steps: ['Open the list: the richest are first, your row is tagged ' + b('YOU') + ', and the next rival to beat is called out above it.', 'Your rank also shows in the WORTH chip of the ticker.'],
            nums: [['Rivals', n('RIVALS.roster', R.roster.length)], ['Richest rival', esc(R.roster[0].name) + ' of ' + esc(R.roster[0].city)]],
            tips: ['Bigger fortunes grow slower in percent, so a small empire can catch up.', 'Passing a rival, or being passed, shows a toast.'],
          };
        }),
      ],
    },
    // ---------------------------------------------------------------- 10 (conditional)
    {
      id: 'companies', title: 'Companies and stocks', when: () => !!(window.CO && window.CO.state && window.CO.state.enabled), entries: [
        E('company', 'Real-player companies', 'company companies members invite role bank wallet ledger businesses', () => ({
          what: 'On the hosted site you can found or join a company with other real players. The server owns the members, roles, bank and ledger; the game only displays and sends requests.',
          where: 'The ' + b('COMPANY') + ' button (it only exists on a server with companies switched on). Tabs: ' + b('OVERVIEW') + ', ' + b('MEMBERS') + ', ' + b('BUSINESSES') + ', ' + b('BANK') + '.',
          steps: ['Found a company or accept an invite.', 'Assign your businesses to it: their income then goes to the company bank.', 'Use the ' + b('BANK') + ' tab to move money between the company bank and your own accounts.'],
          tips: ['What each role may do is decided by the company’s owner and by the server’s rules.'],
        })),
        E('stocks', 'Company stocks', 'stocks shares dividends order company listing', () => ({
          what: 'Companies can list shares that players trade. The server owns listings, matching, prices and dividends.',
          where: 'The ' + b('STOCKS') + ' button (only when the server has stocks on).',
          steps: ['Pick a company to see its quote and chart.', 'Place a buy or sell order; resting orders can be cancelled.'],
        })),
      ],
    },
    // ---------------------------------------------------------------- 11
    {
      id: 'saves', title: 'Saves, sync and graphics', entries: [
        E('saves', 'Saving, exporting and importing', 'save export import file backup sync browser localstorage', () => ({
          what: 'Your world saves in this browser as you play. On the hosted site it also keeps a copy on the server, tied to your GLL ID. A save only exists in the browser it was made in, so a new web address starts empty.',
          where: b('EXPORT SAVE') + ' and ' + b('IMPORT SAVE') + ' sit just under the graphics button at the top of this Help window, and in the footer of the start screen.',
          steps: ['Press ' + b('EXPORT SAVE') + ' to download your world as a file.', 'To restore it (or move to another device), press ' + b('IMPORT SAVE') + ' and pick the file. The game checks it first.'],
          tips: ['Export before you clear your browser data.'],
        })),
        E('graphics', 'Graphics settings', 'graphics shadows trees render scale tone detail lite performance fps', () => ({
          what: 'Levers to make the game run smoothly on a slower device, or look its best on a fast one.',
          where: 'The ' + b('GRAPHICS SETTINGS') + ' button at the top of this window.',
          nums: [['SHADOWS', 'ON or OFF'], ['TREES', 'ON or OFF'], ['RENDER SCALE', 'three steps, from full resolution down to half'], ['TONE', 'MOODY or CLASSIC'], ['DETAIL', 'FULL or LITE'], ['DEFAULTS', 'puts everything back']],
          tips: ['If the picture is slow, lower RENDER SCALE or switch SHADOWS and TREES off.'],
        })),
        E('tutorial', 'The starter guide', 'tutorial guide replay starter quest', () => ({
          what: 'A short guide walks a new tycoon from the first walk to a hired vendor.',
          where: b('REPLAY TUTORIAL') + ' at the bottom of this window.',
        })),
      ],
    },
  ];

  // ====================================================================
  // THE WINDOW
  // ====================================================================
  const FAIL = id => '<p class="hb-fail">This entry could not be read from the game (' + esc(id) + ').</p>';
  function build() {
    const out = [];
    for (const S of SECTIONS) {
      if (S.when && !S.when()) continue;
      const ents = [];
      for (const e of S.entries) {
        let html;
        try { html = render(e.fn()); } catch (er) { console.error('[helpbook]', S.id + '/' + e.id, er); html = FAIL(S.id + '/' + e.id); }
        ents.push({ id: e.id, title: e.title, keys: e.keys, html });
      }
      out.push({ id: S.id, title: S.title, ents });
    }
    return out;
  }
  const bodyText = html => { const d = document.createElement('div'); d.innerHTML = html; return (d.textContent || '').toLowerCase(); };

  function open() {
    const secs = build();
    const sectionsHtml = secs.map(S => '<details class="hb-sec" data-sec="' + S.id + '"><summary>' + esc(S.title) + ' <span class="hb-c">' + S.ents.length + '</span></summary>' +
      S.ents.map(e => '<details class="hb-ent" data-ent="' + S.id + '/' + e.id + '" data-hay="' + esc((e.title + ' ' + e.keys + ' ' + bodyText(e.html)).toLowerCase()) + '"><summary>' + esc(e.title) + '</summary><div class="hb-body">' + e.html + '</div></details>').join('') + '</details>').join('');
    openModal('Open World ' + GAME_VERSION + ' — Help', `
      <div style="display:flex;gap:8px;margin:0 0 12px"><button class="btn primary" id="hp-gfx" style="flex:1">GRAPHICS SETTINGS — shadows · trees · render scale · detail</button></div>
      <div id="hp-academy-slot"></div>
      <input id="hb-q" type="search" placeholder="Search the help book…" autocomplete="off" aria-label="Search the help book">
      <div id="hb-none" class="hidden">Nothing matches. Try a shorter word.</div>
      <div id="hb-list">${sectionsHtml}</div>
      <p class="hb-attr">Map data © OpenStreetMap contributors (ODbL). This game runs 100% in your browser; your world saves locally.</p>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn" id="hp-tut" style="flex:1">REPLAY TUTORIAL</button>
        <button class="btn" id="hp-x" style="flex:1">CLOSE</button>
      </div>`);
    document.getElementById('hp-x').onclick = closeModal;
    document.getElementById('hp-tut').onclick = () => { closeModal(); if (window.TUT) window.TUT.restart(); };
    document.getElementById('hp-gfx').onclick = () => { closeModal(); if (window.GFX) window.GFX.open(); };
    const q = document.getElementById('hb-q');
    q.oninput = () => filter(q.value);
    return secs;
  }
  // the search: every word must appear in an entry's title, keywords or text
  function filter(text) {
    const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
    const list = document.getElementById('hb-list'); if (!list) return 0;
    let shown = 0;
    list.querySelectorAll('.hb-sec').forEach(sec => {
      let any = 0;
      sec.querySelectorAll('.hb-ent').forEach(ent => {
        const hit = !words.length || words.every(w => ent.dataset.hay.indexOf(w) >= 0);
        ent.style.display = hit ? '' : 'none';
        ent.open = !!words.length && hit && words.join(' ').length > 1;
        if (hit) { any++; shown++; }
      });
      sec.style.display = any ? '' : 'none';
      sec.open = !!words.length && any > 0;
    });
    const none = document.getElementById('hb-none'); if (none) none.classList.toggle('hidden', shown > 0 || !words.length);
    return shown;
  }

  return { open, filter, build, sections: () => SECTIONS.map(S => ({ id: S.id, title: S.title, entries: S.entries.map(e => e.id) })) };
})();
window.HELP = HELP;   // QA surface
