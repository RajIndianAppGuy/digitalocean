export function userMessageToOpenAI(step, htmlChunks, name) {
  // console.log("Step---", step);
  // console.log("HTML Chunks---", htmlChunks);
  // console.log("Step String---", stepString);
  // console.log("Name---", name);
  // if (step.retry) {
  //   htmlChunks = step.chunk;
  // }
  const cleanedHtmlChunks = htmlChunks;
let userMessage = `You are an expert in identifying Playwright selectors for web automation tasks. The test name is "${name}". You are now tasked with generating a unique and efficient selector based on the given HTML chunks.`

if (step.actionType === "Click Element") {
  userMessage += `
You are provided with the image of a webpage and the corresponding HTML chunks of that webpage. The following HTML chunks:

${cleanedHtmlChunks}

These HTML chunks represent parts of a webpage's structure, which may contain irrelevant information. Your task is to:

- Locate the HTML element that visually or semantically resembles a **clickable button or selectable option**, or matches the element named "${step.details.element}".
- The target element could be a <button>, <a>, <div>, <span>, or any other element styled to look or behave like a button or selection tile.
- Prioritize **visually distinct, tile-like elements** if the element name includes phrases like "select", "choose template", "pick slide", or similar.
- Avoid clicking **primary CTA buttons** like "Continue", "Next", "Enter", etc., unless they explicitly match the desired element label.
- This is for desktop only: **ignore elements hidden or styled differently for mobile** (e.g., classes like "sm:", "hidden", "md:hidden").
- When determining the selector:
  - Prefer **stable and meaningful attributes** such as "id", "name", "aria-label", "href", or **non-dynamic class names**.
  - Avoid dynamic or auto-generated attributes (e.g., class names with random hashes or numbers).
  - If using a text-based selector (e.g., "has-text"), ensure exact match including punctuation, spaces, and case.
- If multiple similar elements are found, rely on the **visual context** (e.g., tile vs. footer button) to choose the best match.
- Extract a **precise, minimal, and unambiguous Playwright selector** that would click the correct element. Return only the selector.

Ensure that the target is clearly a selection/tile (if applicable), and not a navigation or confirmation button unless explicitly required.`
} else {
    userMessage += `
    You are provided with the image of a webpage and corresponding HTML chunks of that webpage, following HTML chunks:

${cleanedHtmlChunks}

These HTML chunks represent parts of a webpage's structure, which may contain irrelevant information. Your task is to:

- Identify the HTML element matching the  field named "${step.details.description}".
- Take help of the image to understand the corresponding chunk for the "${step.details.element}".
- Extract a unique and valid Playwright selector to **fill** this element.
- Copy the attribute of the element which you decided to be the Playwright selector **as-is**, without trimming or modifying any character, including leading and trailing whitespaces.
- Ensure the selector is precise enough to target the correct field without ambiguity, focusing on attributes such as "id", "name", or well-defined classes.
- Prioritize attributes that are stable and likely to remain unchanged.
- When using text-based selectors (like placeholder text), make sure to account for **all spaces, including leading and trailing spaces**, to ensure accuracy and avoid trimming or altering the text in any way.
  `;
  }

  return userMessage;
}
export function extensionMessageToOpenAI(element) {
  let userMessage = `
 You will receive an HTML element that I clicked on. Your task is to identify what type of element it is and categorize it into one of two categories: "Click Element" or "Fill Input". The criteria are as follows:

Click Element: If the element appears to be clickable, such as a button, link, or any other HTML tag designed for click interactions, it should be categorized under "Click Element".
Fill Input: If the element is intended for user input, like a text field, checkbox, radio button, or any other input-related element, it should fall under "Fill Input".
You have to also extract the name of the content on which I clicked from the html element(not necessarily present as an explicit attribute you need to extract it by understanding the context of element), in case of "Fill Input" the name will be from either  placeholder/value/label
Consider radio-button category as "Click Element" and its value as name
Return the output in the following json format: {"category": "categorized answer", "name": "name extracted"}, where "categorized answer" is either "Click Element" or "Fill Input," and "name extracted" is the name or identifier of the element clicked on. Do not include any additional information about the output format and do not enclose it in json tag.

Here is the element to analyze: ${element}
 `;

  return userMessage;
}

export function CreatePlaywrightSelector() {
  const playwrightSelectorJSON = {
    name: "create_playwright_selector_json",
    description: `Your task is to extract a unique and efficient Playwright selector. Given the HTML chunks and the element information, create a JSON object with the selector.`,
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "The extracted unique and efficient Playwright selector.",
        },
      },
      required: ["selector"],
    },
  };

  return playwrightSelectorJSON;
}

export function cleanHtmlChunks(html) {
  // Remove script tags and comments from the HTML chunks
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}
