import axios from "axios";

export async function Testing(req, res) {
    try {
        let { url } = req.body;
            
        // const response = await axios.get(`http://localhost:3000/api/scrape?url=${url}`);
        
        const response = await axios.get(url);
        const text = response.data;

        res.status(200).json({
            status: "success",
            data: text
        });

    } catch (error) {
        console.log("Error in testing: ", error);
        res.status(500).json({
            status: "error",
            message: "Internal Server Error"
        });
    }
}