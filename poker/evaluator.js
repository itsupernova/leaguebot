const RANK_VALUE = {
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
    '10': 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14
}

const HAND_NAMES = [
    'High Card',
    'Pair',
    'Two Pair',
    'Three of a Kind',
    'Straight',
    'Flush',
    'Full House',
    'Four of a Kind',
    'Straight Flush',
    'Royal Flush'
]

const combinations = (items, size) => {
    const result = []
    const walk = (start, combo) => {
        if (combo.length === size) {
            result.push(combo)
            return
        }

        for (let i = start; i <= items.length - (size - combo.length); i += 1) {
            walk(i + 1, [...combo, items[i]])
        }
    }

    walk(0, [])
    return result
}

const straightHigh = (values) => {
    const unique = [...new Set(values)].sort((a, b) => b - a)
    if (unique.includes(14)) unique.push(1)

    for (let i = 0; i <= unique.length - 5; i += 1) {
        const run = unique.slice(i, i + 5)
        if (run[0] - run[4] === 4) return run[0]
    }

    return null
}

const rankFive = (cards) => {
    const values = cards.map(card => RANK_VALUE[card.rank]).sort((a, b) => b - a)
    const suits = cards.map(card => card.suit)
    const flush = suits.every(suit => suit === suits[0])
    const straight = straightHigh(values)

    const groups = [...values.reduce((map, value) => {
        map.set(value, (map.get(value) || 0) + 1)
        return map
    }, new Map()).entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || b.value - a.value)

    if (flush && straight === 14) return { category: 9, tiebreakers: [14], name: HAND_NAMES[9] }
    if (flush && straight) return { category: 8, tiebreakers: [straight], name: HAND_NAMES[8] }

    if (groups[0].count === 4) {
        const kicker = groups.find(group => group.count === 1).value
        return { category: 7, tiebreakers: [groups[0].value, kicker], name: HAND_NAMES[7] }
    }

    if (groups[0].count === 3 && groups[1].count === 2) {
        return { category: 6, tiebreakers: [groups[0].value, groups[1].value], name: HAND_NAMES[6] }
    }

    if (flush) return { category: 5, tiebreakers: values, name: HAND_NAMES[5] }
    if (straight) return { category: 4, tiebreakers: [straight], name: HAND_NAMES[4] }

    if (groups[0].count === 3) {
        const kickers = groups.filter(group => group.count === 1).map(group => group.value).sort((a, b) => b - a)
        return { category: 3, tiebreakers: [groups[0].value, ...kickers], name: HAND_NAMES[3] }
    }

    if (groups[0].count === 2 && groups[1].count === 2) {
        const pairs = groups.filter(group => group.count === 2).map(group => group.value).sort((a, b) => b - a)
        const kicker = groups.find(group => group.count === 1).value
        return { category: 2, tiebreakers: [...pairs, kicker], name: HAND_NAMES[2] }
    }

    if (groups[0].count === 2) {
        const kickers = groups.filter(group => group.count === 1).map(group => group.value).sort((a, b) => b - a)
        return { category: 1, tiebreakers: [groups[0].value, ...kickers], name: HAND_NAMES[1] }
    }

    return { category: 0, tiebreakers: values, name: HAND_NAMES[0] }
}

export const compareHands = (a, b) => {
    if (a.category !== b.category) return a.category - b.category

    const length = Math.max(a.tiebreakers.length, b.tiebreakers.length)
    for (let i = 0; i < length; i += 1) {
        const diff = (a.tiebreakers[i] || 0) - (b.tiebreakers[i] || 0)
        if (diff !== 0) return diff
    }

    return 0
}

export const evaluateTexasHoldem = (cards) => {
    if (cards.length < 5) throw new Error('At least 5 cards are required')

    return combinations(cards, 5).reduce((best, combo) => {
        const ranked = { ...rankFive(combo), cards: combo }
        if (!best || compareHands(ranked, best) > 0) return ranked
        return best
    }, null)
}

export const handName = (category) => HAND_NAMES[category] || 'Unknown'
