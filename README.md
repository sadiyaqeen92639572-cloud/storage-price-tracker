# CMR Check — Hard Drive Price Tracker

Track $/TB for internal CMR/SMR hard drives and external SSDs. Every listing labeled with recording technology, RAID safety, and warranty. Updated weekly from Amazon.

- 🗄️ **HDD Tracker** — CMR vs SMR labels, RAID-safe badges, $/TB sorted
- ⚡ **SSD Tracker** — External SSD speed (MB/s) vs $/TB, USB interface ceiling

Live at: **[cmrcheck.com](https://cmrcheck.com)**

---

## Free Companion Tools

### [CMR vs SMR Hard Drive Checker](https://sadiyaqeen92639572-cloud.github.io/cmr-smr-checker/)
Instant CMR/SMR verdict for any hard drive — type a name or model number and get a RAID safety rating in seconds. Covers WD Red, IronWolf, Exos, Barracuda, Toshiba N300, and all major drive families. Includes full model number decoder and reference table. Powered by [cmrcheck.com](https://cmrcheck.com).

---

## Data Sources

Prices scraped weekly via ScraperAPI Amazon structured endpoint. CMR/SMR classification from manufacturer specifications and model number databases.

## GitHub Actions

Weekly auto-update every Monday:
- `update-hdd.yml` — 6am UTC
- `update-ssd.yml` — 7am UTC

Requires `SCRAPERAPI_KEY` secret in repository Settings → Secrets → Actions.
