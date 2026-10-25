(function attachStepPattern(root) {
    const STEP_TOKEN = /^(?:[1-9]|1[0-6])$/;

    function stepTokens(value) {
        return String(value ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
    }

    function parseStepList(value) {
        return Array.from(
            new Set(
                stepTokens(value)
                    .filter((part) => STEP_TOKEN.test(part))
                    .map((part) => Number(part))
            )
        ).sort((left, right) => left - right);
    }

    function rejectedStepTokens(value) {
        return stepTokens(value).filter((part) => !STEP_TOKEN.test(part));
    }

    root.strudelStepPattern = {
        parseStepList,
        rejectedStepTokens
    };
})(globalThis);
