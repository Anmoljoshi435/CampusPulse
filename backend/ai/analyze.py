import json
import re
import sys

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
except ImportError:
    TfidfVectorizer = None
    cosine_similarity = None

CATEGORIES = {
    'wifi': ['wifi', 'internet', 'network', 'router', 'connect'],
    'electricity': ['electric', 'power', 'light', 'socket'],
    'water': ['water', 'leak', 'tap', 'drinking'],
    'cleanliness': ['clean', 'garbage', 'litter', 'dirty', 'waste'],
    'security': ['security', 'unsafe', 'guard', 'theft'],
    'transport': ['bus', 'transport', 'shuttle'],
    'classroom': ['projector', 'class', 'desk', 'bench'],
    'canteen': ['canteen', 'food', 'table', 'cafeteria'],
    'infrastructure': ['building', 'road', 'ceiling', 'door', 'lift']
}
SIMILARITY_THRESHOLD = 0.35


def classify(text):
    lowered = text.lower()
    scores = {
        key: sum(lowered.count(term) for term in terms)
        for key, terms in CATEGORIES.items()
    }
    category = max(scores, key=scores.get) if max(scores.values()) else 'other'
    urgency = sum(
        lowered.count(word)
        for word in ['urgent', 'danger', 'broken', 'leak', 'not working', 'unsafe', 'critical']
    )
    priority = 'Critical' if urgency >= 2 else 'High' if urgency else 'Medium'
    return ('WiFi' if category == 'wifi' else category.title(), priority)


def similarity_scores(text, existing):
    documents = [text] + [
        f"{item.get('title', '')} {item.get('description', '')}"
        for item in existing
    ]
    if TfidfVectorizer:
        matrix = TfidfVectorizer(stop_words='english').fit_transform(documents)
        return cosine_similarity(matrix[0:1], matrix[1:]).flatten().tolist()

    words = lambda value: set(re.findall(r'[a-z]+', value.lower()))
    current = words(text)
    return [
        len(current & words(document)) / len(current | words(document))
        if current | words(document) else 0
        for document in documents[1:]
    ]


def complaint_analysis(data):
    text = f"{data.get('title', '')} {data.get('description', '')}"
    category, priority = classify(text)
    existing = data.get('existing', [])
    scores = similarity_scores(text, existing)
    matches = [
        {'id': item.get('id'), 'score': round(score, 4)}
        for item, score in zip(existing, scores)
        if score >= SIMILARITY_THRESHOLD
    ]
    matches.sort(key=lambda item: item['score'], reverse=True)
    location = data.get('location') or 'the reported location'
    details = re.sub(r'\s+', ' ', data.get('description', '')).strip()
    summary = (
        f"{data.get('title', 'Issue')} — {location}, "
        f"{len(matches)} related reports, {priority} severity"
    )
    if details:
        summary += f", {details[:140]}"
    return {
        'category': category,
        'priority': priority,
        'similar_count': len(matches),
        'matches': matches,
        'duplicate': matches[0] if matches else None,
        'summary': summary
    }


def trend_analysis(data):
    current = {}
    previous = {}
    for item in data.get('history', []):
        key = f"{item.get('category', 'Other')}|{item.get('location', 'Unknown')}"
        target = current if item.get('period') == 'current' else previous
        target[key] = target.get(key, 0) + 1

    alerts = []
    for key, count in current.items():
        old_count = previous.get(key, 0)
        if count >= 3 and (old_count == 0 or count >= old_count * 1.5):
            category, location = key.split('|', 1)
            alerts.append({
                'category': category,
                'location': location,
                'current_count': count,
                'previous_count': old_count,
                'message': f'{category} complaints in {location} increased significantly this week.'
            })
    return {'alerts': sorted(alerts, key=lambda item: item['current_count'], reverse=True)}


def summary_analysis(data):
    summaries = []
    for group in data.get('groups', []):
        details = re.sub(r'\s+', ' ', group.get('details', '')).strip()
        summary = (
            f"{group.get('category', 'Other')} issue in {group.get('location', 'Unknown')} — "
            f"{group.get('report_count', 0)} related reports, "
            f"{group.get('severity', 'Medium')} severity"
        )
        if details:
            summary += f", key details: {details[:180]}"
        summaries.append({**group, 'summary': summary})
    return {'summaries': summaries}


def main():
    data = json.loads(sys.stdin.read())
    if data.get('mode') == 'trends':
        result = trend_analysis(data)
    elif data.get('mode') == 'summaries':
        result = summary_analysis(data)
    else:
        result = complaint_analysis(data)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
